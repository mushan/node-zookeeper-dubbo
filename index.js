'use strict';
const net       = require('net');
const hessian   = require('hessian.js');
const url       = require('url');
const zookeeper = require('node-zookeeper-client');
const qs        = require('querystring');
const reg       = require('./libs/register');
require('./utils');

// default body max length
const DEFAULT_LEN = 8388608; // 8 * 1024 * 1024

/**
 * Create a zookeeper connection
 *
 * @param {String} conn
 * @param {String} env
 * @param {String} dubboVer
 * @param {Object} services
 * @returns {Object} zoo
 *
 *
 * @constructor
 */
var ZK = function (conn, env, services, dubboVer) {
  if (typeof ZK.instance === 'object') {
    return ZK.instance;
  }
  this.conn     = conn;
  this.env      = env;
  this.services = services || null;
  this.methods  = [];
  this.cached   = {};
  this.dubboVer = dubboVer;
  this.connect();

  ZK.instance = this;
};

ZK.prototype.connect = function (conn) {
  var self = this;
  !this.conn && (this.conn = conn);
  this.client = zookeeper.createClient(this.conn, {
    sessionTimeout: 30000,
    spinDelay     : 1000,
    retries       : 5
  });
  this.client.connect();
  this.client.once('connected', function connect() {
    if (self.services) {
      self.regConsumer();
    }
    console.log('\x1b[32m%s\x1b[0m', 'Yeah zookeeper connected!');
  });
};

ZK.prototype.regConsumer = reg.consumer;
ZK.prototype.close       = function () {
  this.client.close();
};

/**
 * Get a zoo
 *
 * @param {String} group
 * @param {String} path
 * @param {Function} cb
 */

ZK.prototype.getZoo = function (group, path, cb) {
  var self = this;
  self.client.getChildren('/dubbo/' + path + '/providers', watch, handleResult);

  function watch(event) {
    self.getZoo(group, path, cb);
  }

  function handleResult(err, children) {
    var zoo, urlParsed;
    if (err) {
      if (err.code === -4) {
        console.log(err);
      }
      return cb(err);
    }
    if (children && !children.length) {
      return cb(`can\'t find  the zoo: ${path} ,pls check dubbo service!`);
    }

    for (var i = 0, l = children.length; i < l; i++) {
      zoo = qs.parse(decodeURIComponent(children[i]));
      if (zoo.version === self.env) {
        break;
      }
    }
    // Get the first zoo
    urlParsed    = url.parse(Object.keys(zoo)[0]);
    self.methods = zoo.methods.split(',');
    zoo          = {host: urlParsed.hostname, port: urlParsed.port};

    self.cacheZoo(path, zoo);
    cb(null, zoo);
  }
};

ZK.prototype.cacheZoo = function (path, zoo) {
  this.cached[path] = zoo;
};

var Service = function (opt) {
  this._path     = opt.path;
  this._version  = opt.version || '2.5.3.6';
  this._env      = opt.env.toUpperCase();
  this._group    = opt.group;
  this._services = opt.services;

  let implicitArg = {path: this._path, interface: this._path};

  this._version && (implicitArg.version = this._env);
  this._group && (implicitArg.group = this._group);

  implicitArg.timeout = '60000';

  this._attachments = {
    $class: 'java.util.HashMap',
    $     : implicitArg
  };
  this.zk           = new ZK(opt.conn, this._env, this._services, this._version);
};

Service.prototype.excute = function (method, args, cb) {
  var _method         = method;
  var _parameterTypes = '';
  var _arguments      = args;
  var buffer, type, typeRef;

  typeRef = {
    boolean: 'Z', int: 'I', short: 'S',
    long   : 'J', double: 'D', float: 'F'
  };

  if (_arguments.length) {
    for (var i = 0, l = _arguments.length; i < l; i++) {
      type = _arguments[i]['$class'];
      if (type.charAt(0) === '[') {
        _parameterTypes += '[L' + type.slice(1).replace(/\./gi, '/') + ';';
      } else {
        _parameterTypes += type && ~type.indexOf('.')
          ? 'L' + type.replace(/\./gi, '/') + ';'
          : typeRef[type];
      }
    }
    buffer = this.buffer(_method, _parameterTypes, _arguments);
  } else {
    buffer = this.buffer(_method, '');
  }
  var self = this;
  return new Promise(function (resolve, reject) {
    var fromCache     = true;
    var tryConnectZoo = true;
    if (self.zk.cached.hasOwnProperty(self._path)) {
      fetchData(null, self.zk.cached[self._path]);
    } else {
      fromCache = false;
      self.zk.getZoo(self._group, self._path, fetchData);
    }

    function fetchData(err, zoo) {
      if (err) {
        return reject(err);
      }
      var client    = new net.Socket();
      var bl        = 16;
      var host      = zoo.host;
      var port      = zoo.port;
      var ret       = null;
      var chunks    = [];
      var heap;
      var bl_inited = false;

      if (!~self.zk.methods.indexOf(_method) && !fromCache) {
        return reject(`can't find the method:${_method}, pls check it!`);
      }
      client.connect(port, host, function () {
        client.write(buffer);
      });

      client.on('error', function (err) {
        console.log(err);

        // 2s duration reconnect
        if (tryConnectZoo) {
          tryConnectZoo = false;
          setTimeout(handleReconnect, 2000);
        }

        function handleReconnect() {
          tryConnectZoo = true;
          fromCache     = false;
          return self.zk.getZoo(self._group, self._path, fetchData);// reconnect when err occur
        }
      });

      client.on('data', function (chunk) {
        if (!chunks.length) {
          var arr = Array.prototype.slice.call(chunk.slice(0, 16));
          var i   = 0;
          while (i < 3) {
            bl += arr.pop() * Math.pow(256, i++);
          }
        }
        chunks.push(chunk);
        heap = Buffer.concat(chunks);

        (heap.length >= bl) && client.destroy();
      });

      client.on('close', function (err) {
        if (err) {
          return console.log('some err happened, so reconnect, check the err event');
        }
        if (heap[3] !== 20) {
          ret = heap.slice(18, heap.length - 1).toString(); // error捕获
          return reject(ret);
        }
        if (heap[15] === 3 && heap.length < 20) { // 判断是否没有返回值
          return resolve(null);
        }

        try {
          var offset = heap[16] === 145 ? 17 : 18; // 判断传入参数是否有误
          var buf    = new hessian.DecoderV2(heap.slice(offset, heap.length));
          var _ret   = buf.read();
          if (_ret instanceof Error || offset === 18) {
            return reject(_ret);
          }
          ret = JSON.stringify(_ret);
        } catch (err) {
          return reject(err);
        }
        return resolve(ret);
      });
    }
  }).nodeify(cb);
};

Service.prototype.buffer = function (method, type, args) {
  var bufferBody = this.bufferBody(method, type, args);
  var bufferHead = this.bufferHead(bufferBody.length);
  return Buffer.concat([bufferHead, bufferBody]);
};

Service.prototype.bufferHead = function (length) {
  var head = [0xda, 0xbb, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var i    = 15;

  if (length > DEFAULT_LEN) {
    throw new Error(`Data length too large: ${length}, max payload: ${DEFAULT_LEN}`);
  }
  // 构造body长度信息
  if (length - 256 < 0) {
    head.splice(i, 1, length - 256);
  } else {
    while (length - 256 >= 0) {
      head.splice(i--, 1, length % 256);
      length = length >> 8;
    }
    head.splice(i, 1, length);
  }
  return new Buffer(head);
};

Service.prototype.bufferBody = function (method, type, args) {
  var encoder = new hessian.EncoderV2();
  encoder.write(this._version);
  encoder.write(this._path);
  encoder.write(this._env);
  encoder.write(method);
  encoder.write(type);
  if (args && args.length) {
    for (var i = 0, len = args.length; i < len; ++i) {
      encoder.write(args[i]);
    }
  }
  encoder.write(this._attachments);
  encoder = encoder.byteBuffer._bytes.slice(0, encoder.byteBuffer._offset);

  return encoder;
};

module.exports = Service;
