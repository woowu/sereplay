#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const net = require('net');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const { SerialPort } = require('serialport');
const dump = require('buffer-hexdump');
const moment = require('moment');

class SerialStream extends EventEmitter {
    constructor(device, baud, interframeTimeout = 50) {
        super();

        this.serial = new SerialPort({
            path: device,
            baudRate: baud,
            autoOpen: false,
        });
        this._name = device;
        this.timer = null;
        this.buf = null;

        this.serial.open(err => {
            if (err) {
                console.error(`Error opening ${device}:`, err.message);
                process.exit();
            }
        });
        this.serial.on('data', data => {
            clearTimeout(this.timer);
            if (! this.buf)
                this.buf = data;
            else
                this.buf = Buffer.concat([this.buf, data]);
            this.timer = setTimeout(() => {
                this.emit('data', this.buf);
                this.buf = null;
            }, interframeTimeout);
        });
    }

    write(data) {
        this.serial.write(data);
    }

    end() {
        if (this.serial) this.serial.close();
    }

    name() {
        return this._name;
    }
}

const makeLogger = file => {
    const logStream = fs.createWriteStream(file);
    const queue = [];
    var buffWaiting = false;

    const write = () => {
        while (queue.length) {
            const line = queue.shift();
            if (! logStream.write(line)) {
                logStream.once('drain', write);
                buffWaiting = true;
                break;
            }
            buffWaiting = false;
        }
    };

    logStream.on('error', err => {
        console.error(err.message);
        process.exit(1);
    });

    return line => {
        queue.push(line);
        if (queue.length > 1 || buffWaiting) return;
        process.nextTick(write);
    };
};

const timestamp = date => moment(new Date()).format('YYYY-MM-DDTHH:mm:ss.SSSZZ');

const writeTrafficLog = (symbol, data, log) => {
    const now = new Date();
    var logLine = timestamp(new Date());
    logLine += ' ' + symbol + ' ' + data.length + ' ' + data.toString('hex') + '\n';
    log(logLine);
};

const argv = require('yargs/yargs')(process.argv.slice(2))
    .version('0.0.1')
    .alias('version', 'v')
    .help()
    .alias('help', 'h')
    .option('input', {
        alias: 'i',
        describe: 'a file contains the sequence of packets in hex strings',
        demandOption: true,
        nargs: 1,
    })
    .option('device', {
        alias: 'd',
        describe: 'Serial device name',
        demandOption: true,
        nargs: 1,
    })
    .option('baud', {
        alias: 'b',
        describe: 'Serial device baudrate',
        nargs: 1,
        type: 'number',
        default: 115200,
    })
    .option('resp-timeout', {
        alias: 'r',
        describe: 'slave response timeout',
        nargs: 1,
        type: 'number',
        default: 5000,
    })
    .option('inter-frame-timeout', {
        alias: 't',
        describe: 'inter-frame-timeout',
        nargs: 1,
        type: 'number',
        default: 200,
    })
    .option('send-delay', {
        alias: 'D',
        describe: 'delay n msecs before sending',
        nargs: 1,
        type: 'number',
        default: 50,
    })
    .option('packets-selector', {
        alias: 'p',
        describe: 'a range specifier to select packets by index, e.g., 3 1-3 1-3,5',
        nargs: 1,
        type: 'string',
    })
    .option('repeat', {
        alias: 'e',
        describe: 'Repeat the input for n times',
        nargs: 1,
        type: 'number',
        default: 1,
    })
    .option('log', {
        alias: 'l',
        describe: 'log file',
        type: 'string',
    })
    .argv;

argv.respTimeout = +argv.respTimeout;
argv.interFrameTimeout = +argv.interFrameTimeout;
argv.sendDelay = +argv.sendDelay;
if (isNaN(argv.respTimeout) || isNaN(argv.interFrameTimeout) || isNaN(argv.sendDelay)) {
    console.error('bad option value');
    process.exit(1);
}
if (argv.respTimeout < 0 || argv.interFrameTimeout < 0 || argv.sendDelay < 0) {
    console.error('bad option value');
    process.exit(1);
}
if (isNaN(argv.repeat) || argv.repeat < 1 || parseInt(argv.repeat) != argv.repeat) {
    console.error('invalid repeat value');
    process.exit(1);
}

const log = argv.log ? makeLogger(argv.log) : null;
const packetsSelector = argv.packetsSelector ? (function createPacketSelector(spec) {
    const indexSet = new Set();
    spec.split(',').forEach(t => {
        var index = +t;
        if (! isNaN(index)) {
            indexSet.add(index);
            return;
        }
        const fromTo = t.split('-');
        if (fromTo.length != 2) return;
        const from = +fromTo[0];
        const to = +fromTo[1];
        if (isNaN(from) || isNaN(to)) return;
        for (var i = from; i <= to; ++i)
            indexSet.add(i);
    });
    if (! indexSet.size) return null;
    return indexSet;
}(argv.packetsSelector)) : null;

const sendPacketAndWaitResp = (packet, outStream, timeout, cb) => {
    if (! packet) {
        outStream.end();
        return cb(null);
    }

    var timer;
    var onResp;

    const endCall = err => {
        outStream.removeListener('data', onResp);
        clearTimeout(timer);
        cb(err);
    };
    onResp = data => {
        console.log('< ' + timestamp(new Date()) + ' len ' + data.length);
        console.log(dump(data));
        if (log) writeTrafficLog(packet, '>', log);
        endCall(null);
    };

    if (packet.doc) console.log(packet.doc.trim());
    console.log('> ' + timestamp(new Date()) + ' len ' + packet.length);
    console.log(dump(packet));
    outStream.on('data', onResp);
    outStream.write(packet);
    if (log) writeTrafficLog(packet, '>', log);
    timer = setTimeout(() => {
        endCall(new Error('timeout'));
    }, timeout);
};

(function bindInputOutput (inStream, outStream, options) {
    const packetsQueue = [];
    const packetsCopy = [];
    var packetIndex = 0;
    var doc = null;

    const send = () => {
        if (! packetsQueue.length) return;
        const packet = packetsQueue[0];
        if (! packet) {
            packetsQueue.shift();
            outStream.end();
            return;
        }
        sendPacketAndWaitResp(packet, outStream, options.respTimeout, err => {
            if (err) console.error(err.message);
            packetsQueue.shift();
            setTimeout(() => {
                send();
            }, options.sendDelay);
        });
    };

    const rl = require('readline').createInterface({ input: inStream });
    rl.on('line', line => {
        line = line.trim();
        if (! line.length) return;
        if (line[0] == '#') {
            if (! doc)
                doc = line + '\n';
            else
                doc += line + '\n';
            return;
        }
        if (! options.packetsSelector || options.packetsSelector.has(packetIndex)) {
            const packet = Buffer.from(line.split(' ').join(''), 'hex');
            packet.doc = doc;
            packetsQueue.push(packet);
            packetsCopy.push(packet);
            if (packetsQueue.length == 1) process.nextTick(send);
        }
        doc = null;
        ++packetIndex;
    });
    rl.on('close', () => {
        while (options.repeats > 1) {
            packetsCopy.forEach(p => {
                packetsQueue.push(p);
            });
            --options.repeats;
        }
        packetsQueue.push(null);
        if (packetsQueue.length == 1) process.nextTick(send);
    });
}(fs.createReadStream(argv.input)
    , new SerialStream(argv.device, argv.baud, argv.interFrameTimeout)
    , {
        respTimeout: argv.respTimeout,
        sendDelay: argv.sendDelay,
        packetsSelector,
        repeats: argv.repeat,
    }));
