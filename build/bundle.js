module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};

/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {

/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;

/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};

/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;

/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}


/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;

/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;

/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "/build/";

/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var Auth0 = __webpack_require__(1);
	var async = __webpack_require__(2);
	var moment = __webpack_require__(3);
	var useragent = __webpack_require__(4);
	var express = __webpack_require__(5);
	var Webtask = __webpack_require__(6);
	var app = express();
	var Sumologic = __webpack_require__(9);
	var Request = __webpack_require__(18);
	var memoizer = __webpack_require__(19);

	function lastLogCheckpoint(req, res) {
	  var ctx = req.webtaskContext;
	  var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'SUMOLOGIC_URL'];
	  var missing_settings = required_settings.filter(function (setting) {
	    return !ctx.data[setting];
	  });

	  if (missing_settings.length) {
	    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
	  }

	  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
	  req.webtaskContext.storage.get(function (err, data) {
	    var startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

	    if (err) {
	      console.log('storage.get', err);
	    }

	    // Initialize both clients.
	    var auth0 = new Auth0.ManagementClient({
	      domain: ctx.data.AUTH0_DOMAIN,
	      token: req.access_token
	    });

	    // WAS IMPORTED USING UPPER CASE..
	    var logger = Sumologic.createClient({
	      url: ctx.data.SUMOLOGIC_URL
	    });

	    // Start the process.
	    async.waterfall([function (callback) {
	      var getLogs = function getLogs(context) {
	        console.log('Logs from: ' + (context.checkpointId || 'Start') + '.');

	        var take = Number.parseInt(ctx.data.BATCH_SIZE);

	        take = take > 100 ? 100 : take;

	        context.logs = context.logs || [];

	        getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, function (logs, err) {
	          if (err) {
	            console.log('Error getting logs from Auth0', err);
	            return callback(err);
	          }

	          if (logs && logs.length) {
	            logs.forEach(function (l) {
	              return context.logs.push(l);
	            });
	            context.checkpointId = context.logs[context.logs.length - 1]._id;
	            // return setImmediate(() => getLogs(context));
	          }

	          console.log('Total logs: ' + context.logs.length + '.');
	          return callback(null, context);
	        });
	      };

	      getLogs({ checkpointId: startCheckpointId });
	    }, function (context, callback) {
	      var min_log_level = parseInt(ctx.data.LOG_LEVEL) || 0;
	      var log_matches_level = function log_matches_level(log) {
	        if (logTypes[log.type]) {
	          return logTypes[log.type].level >= min_log_level;
	        }
	        return true;
	      };

	      var types_filter = ctx.data.LOG_TYPES && ctx.data.LOG_TYPES.split(',') || [];
	      var log_matches_types = function log_matches_types(log) {
	        if (!types_filter || !types_filter.length) return true;
	        return log.type && types_filter.indexOf(log.type) >= 0;
	      };

	      context.logs = context.logs.filter(function (l) {
	        return l.type !== 'sapi' && l.type !== 'fapi';
	      }).filter(log_matches_level).filter(log_matches_types);

	      callback(null, context);
	    }, function (context, callback) {
	      console.log('Sending ' + context.logs.length);

	      // sumologic here...
	      context.logs.forEach(function (log, idx) {
	        context.logs[idx] = JSON.stringify(log);
	      });

	      logger.log(context.logs, function (err) {
	        if (err) {
	          console.log('Error sending logs to Sumologic', err);
	          return callback(err);
	        }

	        console.log('Upload complete.');

	        return callback(null, context);
	      });
	    }], function (err, context) {
	      if (err) {
	        console.log('Job failed.', err);

	        return req.webtaskContext.storage.set({ checkpointId: startCheckpointId }, { force: 1 }, function (error) {
	          if (error) {
	            console.log('Error storing startCheckpoint', error);
	            return res.status(500).send({ error: error });
	          }

	          res.status(500).send({
	            error: err
	          });
	        });
	      }

	      console.log('Job complete.');

	      return req.webtaskContext.storage.set({
	        checkpointId: context.checkpointId,
	        totalLogsProcessed: context.logs.length
	      }, { force: 1 }, function (error) {
	        if (error) {
	          console.log('Error storing checkpoint', error);
	          return res.status(500).send({ error: error });
	        }

	        res.sendStatus(200);
	      });
	    });
	  });
	}

	var logTypes = {
	  's': {
	    event: 'Success Login',
	    level: 1 // Info
	  },
	  'seacft': {
	    event: 'Success Exchange',
	    level: 1 // Info
	  },
	  'feacft': {
	    event: 'Failed Exchange',
	    level: 3 // Error
	  },
	  'f': {
	    event: 'Failed Login',
	    level: 3 // Error
	  },
	  'w': {
	    event: 'Warnings During Login',
	    level: 2 // Warning
	  },
	  'du': {
	    event: 'Deleted User',
	    level: 1 // Info
	  },
	  'fu': {
	    event: 'Failed Login (invalid email/username)',
	    level: 3 // Error
	  },
	  'fp': {
	    event: 'Failed Login (wrong password)',
	    level: 3 // Error
	  },
	  'fc': {
	    event: 'Failed by Connector',
	    level: 3 // Error
	  },
	  'fco': {
	    event: 'Failed by CORS',
	    level: 3 // Error
	  },
	  'con': {
	    event: 'Connector Online',
	    level: 1 // Info
	  },
	  'coff': {
	    event: 'Connector Offline',
	    level: 3 // Error
	  },
	  'fcpro': {
	    event: 'Failed Connector Provisioning',
	    level: 4 // Critical
	  },
	  'ss': {
	    event: 'Success Signup',
	    level: 1 // Info
	  },
	  'fs': {
	    event: 'Failed Signup',
	    level: 3 // Error
	  },
	  'cs': {
	    event: 'Code Sent',
	    level: 0 // Debug
	  },
	  'cls': {
	    event: 'Code/Link Sent',
	    level: 0 // Debug
	  },
	  'sv': {
	    event: 'Success Verification Email',
	    level: 0 // Debug
	  },
	  'fv': {
	    event: 'Failed Verification Email',
	    level: 0 // Debug
	  },
	  'scp': {
	    event: 'Success Change Password',
	    level: 1 // Info
	  },
	  'fcp': {
	    event: 'Failed Change Password',
	    level: 3 // Error
	  },
	  'sce': {
	    event: 'Success Change Email',
	    level: 1 // Info
	  },
	  'fce': {
	    event: 'Failed Change Email',
	    level: 3 // Error
	  },
	  'scu': {
	    event: 'Success Change Username',
	    level: 1 // Info
	  },
	  'fcu': {
	    event: 'Failed Change Username',
	    level: 3 // Error
	  },
	  'scpn': {
	    event: 'Success Change Phone Number',
	    level: 1 // Info
	  },
	  'fcpn': {
	    event: 'Failed Change Phone Number',
	    level: 3 // Error
	  },
	  'svr': {
	    event: 'Success Verification Email Request',
	    level: 0 // Debug
	  },
	  'fvr': {
	    event: 'Failed Verification Email Request',
	    level: 3 // Error
	  },
	  'scpr': {
	    event: 'Success Change Password Request',
	    level: 0 // Debug
	  },
	  'fcpr': {
	    event: 'Failed Change Password Request',
	    level: 3 // Error
	  },
	  'fn': {
	    event: 'Failed Sending Notification',
	    level: 3 // Error
	  },
	  'sapi': {
	    event: 'API Operation'
	  },
	  'fapi': {
	    event: 'Failed API Operation'
	  },
	  'limit_wc': {
	    event: 'Blocked Account',
	    level: 4 // Critical
	  },
	  'limit_ui': {
	    event: 'Too Many Calls to /userinfo',
	    level: 4 // Critical
	  },
	  'api_limit': {
	    event: 'Rate Limit On API',
	    level: 4 // Critical
	  },
	  'sdu': {
	    event: 'Successful User Deletion',
	    level: 1 // Info
	  },
	  'fdu': {
	    event: 'Failed User Deletion',
	    level: 3 // Error
	  }
	};

	function getLogsFromAuth0(domain, token, take, from, cb) {
	  var url = 'https://' + domain + '/api/v2/logs';

	  Request.get(url).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json').query({ take: take }).query({ from: from }).query({ sort: 'date:1' }).query({ per_page: take }).end(function (err, res) {
	    if (err || !res.ok) {
	      console.log('Error getting logs', err);
	      cb(null, err);
	    } else {
	      console.log('x-ratelimit-limit: ', res.headers['x-ratelimit-limit']);
	      console.log('x-ratelimit-remaining: ', res.headers['x-ratelimit-remaining']);
	      console.log('x-ratelimit-reset: ', res.headers['x-ratelimit-reset']);
	      cb(res.body);
	    }
	  });
	}

	var getTokenCached = memoizer({
	  load: function load(apiUrl, audience, clientId, clientSecret, cb) {
	    Request.post(apiUrl).send({
	      audience: audience,
	      grant_type: 'client_credentials',
	      client_id: clientId,
	      client_secret: clientSecret
	    }).type('application/json').end(function (err, res) {
	      if (err || !res.ok) {
	        cb(null, err);
	      } else {
	        cb(res.body.access_token);
	      }
	    });
	  },
	  hash: function hash(apiUrl) {
	    return apiUrl;
	  },
	  max: 100,
	  maxAge: 1000 * 60 * 60
	});

	app.use(function (req, res, next) {
	  var apiUrl = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/oauth/token';
	  var audience = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/api/v2/';
	  var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
	  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

	  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
	    if (err) {
	      console.log('Error getting access_token', err);
	      return next(err);
	    }

	    req.access_token = access_token;
	    next();
	  });
	});

	app.get('/', lastLogCheckpoint);
	app.post('/', lastLogCheckpoint);

	module.exports = Webtask.fromExpress(app);

/***/ },
/* 1 */
/***/ function(module, exports) {

	module.exports = require("auth0@2.1.0");

/***/ },
/* 2 */
/***/ function(module, exports) {

	module.exports = require("async");

/***/ },
/* 3 */
/***/ function(module, exports) {

	module.exports = require("moment");

/***/ },
/* 4 */
/***/ function(module, exports) {

	module.exports = require("useragent");

/***/ },
/* 5 */
/***/ function(module, exports) {

	module.exports = require("express");

/***/ },
/* 6 */
/***/ function(module, exports, __webpack_require__) {

	exports.fromConnect = exports.fromExpress = fromConnect;
	exports.fromHapi = fromHapi;
	exports.fromServer = exports.fromRestify = fromServer;


	// API functions

	function fromConnect (connectFn) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return connectFn(req, res);
	    };
	}

	function fromHapi(server) {
	    var webtaskContext;

	    server.ext('onRequest', function (request, response) {
	        var normalizeRouteRx = createRouteNormalizationRx(request.x_wt.jtn);

	        request.setUrl(request.url.replace(normalizeRouteRx, '/'));
	        request.webtaskContext = webtaskContext;
	    });

	    return function (context, req, res) {
	        var dispatchFn = server._dispatch();

	        webtaskContext = attachStorageHelpers(context);

	        dispatchFn(req, res);
	    };
	}

	function fromServer(httpServer) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return httpServer.emit('request', req, res);
	    };
	}


	// Helper functions

	function createRouteNormalizationRx(jtn) {
	    var normalizeRouteBase = '^\/api\/run\/[^\/]+\/';
	    var normalizeNamedRoute = '(?:[^\/\?#]*\/?)?';

	    return new RegExp(
	        normalizeRouteBase + (
	        jtn
	            ?   normalizeNamedRoute
	            :   ''
	    ));
	}

	function attachStorageHelpers(context) {
	    context.read = context.secrets.EXT_STORAGE_URL
	        ?   readFromPath
	        :   readNotAvailable;
	    context.write = context.secrets.EXT_STORAGE_URL
	        ?   writeToPath
	        :   writeNotAvailable;

	    return context;


	    function readNotAvailable(path, options, cb) {
	        var Boom = __webpack_require__(7);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function readFromPath(path, options, cb) {
	        var Boom = __webpack_require__(7);
	        var Request = __webpack_require__(8);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'GET',
	            headers: options.headers || {},
	            qs: { path: path },
	            json: true,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode === 404 && Object.hasOwnProperty.call(options, 'defaultValue')) return cb(null, options.defaultValue);
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null, body);
	        });
	    }

	    function writeNotAvailable(path, data, options, cb) {
	        var Boom = __webpack_require__(7);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function writeToPath(path, data, options, cb) {
	        var Boom = __webpack_require__(7);
	        var Request = __webpack_require__(8);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'PUT',
	            headers: options.headers || {},
	            qs: { path: path },
	            body: data,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null);
	        });
	    }
	}


/***/ },
/* 7 */
/***/ function(module, exports) {

	module.exports = require("boom");

/***/ },
/* 8 */
/***/ function(module, exports) {

	module.exports = require("request");

/***/ },
/* 9 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var sumologic = exports;

	sumologic.version       = __webpack_require__(10).version;
	sumologic.createClient  = __webpack_require__(11).createClient;



/***/ },
/* 10 */
/***/ function(module, exports) {

	module.exports = {
		"name": "logs-to-sumologic",
		"description": "A simple sumologic log client tool",
		"version": "1.0.2",
		"author": {
			"name": "Richard Seldon",
			"email": "arcseldon@gmail.com"
		},
		"repository": {
			"type": "git",
			"url": "git+ssh://git@github.com/tawawa/logs-to-sumologic.git"
		},
		"keywords": [
			"logging",
			"sumologic"
		],
		"dependencies": {
			"request": "2.67.x",
			"json-stringify-safe": "5.0.x"
		},
		"main": "./lib/sumologic",
		"license": "MIT",
		"engines": {
			"node": ">= 0.8.0"
		},
		"gitHead": "1e067d9e01090d394ef388e24fe6c957acb48722",
		"bugs": {
			"url": "https://github.com/tawawa/logs-to-sumologic/issues"
		},
		"homepage": "https://github.com/tawawa/logs-to-sumologic#readme",
		"_id": "logs-to-sumologic@1.0.2",
		"scripts": {},
		"_shasum": "ade4853f9e2e7d6211887ebf71386fda34d253d2",
		"_from": "logs-to-sumologic@latest",
		"_npmVersion": "3.8.3",
		"_nodeVersion": "5.10.0",
		"_npmUser": {
			"name": "arcseldon",
			"email": "arcseldon@hotmail.com"
		},
		"dist": {
			"shasum": "ade4853f9e2e7d6211887ebf71386fda34d253d2",
			"tarball": "https://registry.npmjs.org/logs-to-sumologic/-/logs-to-sumologic-1.0.2.tgz"
		},
		"maintainers": [
			{
				"name": "arcseldon",
				"email": "arcseldon@hotmail.com"
			}
		],
		"_npmOperationalInternal": {
			"host": "packages-12-west.internal.npmjs.com",
			"tmp": "tmp/logs-to-sumologic-1.0.2.tgz_1460736560119_0.3139945878647268"
		},
		"directories": {},
		"_resolved": "https://registry.npmjs.org/logs-to-sumologic/-/logs-to-sumologic-1.0.2.tgz"
	};

/***/ },
/* 11 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var events = __webpack_require__(12),
	  util = __webpack_require__(13),
	  qs = __webpack_require__(14),
	  common = __webpack_require__(15),
	  sumologic = __webpack_require__(9),
	  stringifySafe = __webpack_require__(17);

	function stringify(msg) {
	  var payload;

	  try {
	    payload = JSON.stringify(msg)
	  }
	  catch (ex) {
	    payload = stringifySafe(msg, null, null, noop)
	  }

	  return payload;
	}

	exports.createClient = function (options) {
	  return new Sumologic(options);
	};

	var Sumologic = exports.Sumologic = function (options) {

	  if (!options || !options.url) {
	    throw new Error('options.url is required.');
	  }

	  events.EventEmitter.call(this);

	  this.url = options.url;
	  this.json = options.json || null;
	  this.auth = options.auth || null;
	  this.proxy = options.proxy || null;
	  this.userAgent = 'logs-to-sumologic ' + sumologic.version;

	};

	util.inherits(Sumologic, events.EventEmitter);

	Sumologic.prototype.log = function (msg, callback) {

	  var self = this,
	    logOptions;

	  var isBulk = Array.isArray(msg);

	  function serialize(msg) {
	    if (msg instanceof Object) {
	      return self.json ? stringify(msg) : common.serialize(msg);
	    }
	    else {
	      return self.json ? stringify({message: msg}) : msg;
	    }
	  }

	  msg = isBulk ? msg.map(serialize).join('\n') : serialize(msg);
	  msg = serialize(msg);

	  logOptions = {
	    uri: this.url,
	    method: 'POST',
	    body: msg,
	    proxy: this.proxy,
	    headers: {
	      host: this.host,
	      accept: '*/*',
	      'user-agent': this.userAgent,
	      'content-type': this.json ? 'application/json' : 'text/plain',
	      'content-length': Buffer.byteLength(msg)
	    }
	  };

	  common.sumologic(logOptions, callback, function (res, body) {
	    try {
	      var result = '';
	      try {
	        result = JSON.parse(body);
	      } catch (e) {
	        // do nothing
	      }
	      self.emit('log', result);
	      if (callback) {
	        callback(null, result);
	      }
	    } catch (ex) {
	      if (callback) {
	        callback(new Error('Unspecified error from Sumologic: ' + ex));
	      }
	    }
	  });

	  return this;
	};




/***/ },
/* 12 */
/***/ function(module, exports) {

	module.exports = require("events");

/***/ },
/* 13 */
/***/ function(module, exports) {

	module.exports = require("util");

/***/ },
/* 14 */
/***/ function(module, exports) {

	module.exports = require("querystring");

/***/ },
/* 15 */
/***/ function(module, exports, __webpack_require__) {

	
	var https = __webpack_require__(16),
	    util = __webpack_require__(13),
	    request = __webpack_require__(8),
	    sumologic = __webpack_require__(9);

	var common = exports;

	var failCodes = common.failCodes = {
	  400: 'Bad Request',
	  401: 'Unauthorized',
	  403: 'Forbidden',
	  404: 'Not Found',
	  409: 'Conflict / Duplicate',
	  410: 'Gone',
	  500: 'Internal Server Error',
	  501: 'Not Implemented',
	  503: 'Throttled'
	};

	common.sumologic = function () {
	  var args = Array.prototype.slice.call(arguments),
	      success = args.pop(),
	      callback = args.pop(),
	      responded,
	      requestBody,
	      headers,
	      method,
	      auth,
	      proxy,
	      uri;

	  if (args.length === 1) {
	    if (typeof args[0] === 'string') {
	      //
	      // If we got a string assume that it's the URI
	      //
	      method = 'GET';
	      uri    = args[0];
	    }
	    else {
	      method      = args[0].method || 'GET';
	      uri         = args[0].uri;
	      requestBody = args[0].body;
	      auth        = args[0].auth;
	      headers     = args[0].headers;
	      proxy       = args[0].proxy;
	    }
	  }
	  else if (args.length === 2) {
	    method = 'GET';
	    uri    = args[0];
	    auth   = args[1];
	  }
	  else {
	    method = args[0];
	    uri    = args[1];
	    auth   = args[2];
	  }

	  function onError(err) {
	    if (!responded) {
	      responded = true;
	      if (callback) { callback(err) }
	    }
	  }

	  var requestOptions = {
	    uri: uri,
	    method: method,
	    headers: headers || {},
	    proxy: proxy
	  };

	  if (auth) {
	    requestOptions.headers.authorization = 'Basic ' + new Buffer(auth.username + ':' + auth.password).toString('base64');
	  }

	  if (requestBody) {
	    requestOptions.body = requestBody;
	  }

	  try {
	    request(requestOptions, function (err, res, body) {
	      if (err) {
	        return onError(err);
	      }
	      var statusCode = res.statusCode.toString();
	      if (Object.keys(failCodes).indexOf(statusCode) !== -1) {
	        return onError((new Error('Sumologic Error (' + statusCode + ')')));
	      }
	      success(res, body);
	    });
	  }
	  catch (ex) {
	    onError(ex);
	  }
	};

	common.serialize = function (obj, key) {
	  if (obj === null) {
	    obj = 'null';
	  }
	  else if (obj === undefined) {
	    obj = 'undefined';
	  }
	  else if (obj === false) {
	    obj = 'false';
	  }

	  if (typeof obj !== 'object') {
	    return key ? key + '=' + obj : obj;
	  }

	  var msg = '',
	      keys = Object.keys(obj),
	      length = keys.length;

	  for (var i = 0; i < length; i++) {
	    if (Array.isArray(obj[keys[i]])) {
	      msg += keys[i] + '=[';

	      for (var j = 0, l = obj[keys[i]].length; j < l; j++) {
	        msg += common.serialize(obj[keys[i]][j]);
	        if (j < l - 1) {
	          msg += ', ';
	        }
	      }

	      msg += ']';
	    }
	    else {
	      msg += common.serialize(obj[keys[i]], keys[i]);
	    }

	    if (i < length - 1) {
	      msg += ', ';
	    }
	  }
	  return msg;
	};

	common.clone = function (obj) {
	  var clone = {};
	  for (var i in obj) {
	    clone[i] = obj[i] instanceof Object ? common.clone(obj[i]) : obj[i];
	  }
	  return clone;
	};


/***/ },
/* 16 */
/***/ function(module, exports) {

	module.exports = require("https");

/***/ },
/* 17 */
/***/ function(module, exports) {

	module.exports = require("json-stringify-safe");

/***/ },
/* 18 */
/***/ function(module, exports) {

	module.exports = require("superagent");

/***/ },
/* 19 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate) {const LRU = __webpack_require__(22);
	const _ = __webpack_require__(23);
	const lru_params =  [ 'max', 'maxAge', 'length', 'dispose', 'stale' ];

	module.exports = function (options) {
	  var cache = new LRU(_.pick(options, lru_params));
	  var load = options.load;
	  var hash = options.hash;

	  var result = function () {
	    var args = _.toArray(arguments);
	    var parameters = args.slice(0, -1);
	    var callback = args.slice(-1).pop();

	    var key;

	    if (parameters.length === 0 && !hash) {
	      //the load function only receives callback.
	      key = '_';
	    } else {
	      key = hash.apply(options, parameters);
	    }

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return setImmediate.apply(null, [callback, null].concat(fromCache));
	    }

	    load.apply(null, parameters.concat(function (err) {
	      if (err) {
	        return callback(err);
	      }

	      cache.set(key, _.toArray(arguments).slice(1));

	      return callback.apply(null, arguments);

	    }));

	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};


	module.exports.sync = function (options) {
	  var cache = new LRU(_.pick(options, lru_params));
	  var load = options.load;
	  var hash = options.hash;

	  var result = function () {
	    var args = _.toArray(arguments);

	    var key = hash.apply(options, args);

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return fromCache;
	    }

	    var result = load.apply(null, args);

	    cache.set(key, result);

	    return result;
	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(20).setImmediate))

/***/ },
/* 20 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate, clearImmediate) {var nextTick = __webpack_require__(21).nextTick;
	var apply = Function.prototype.apply;
	var slice = Array.prototype.slice;
	var immediateIds = {};
	var nextImmediateId = 0;

	// DOM APIs, for completeness

	exports.setTimeout = function() {
	  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
	};
	exports.setInterval = function() {
	  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
	};
	exports.clearTimeout =
	exports.clearInterval = function(timeout) { timeout.close(); };

	function Timeout(id, clearFn) {
	  this._id = id;
	  this._clearFn = clearFn;
	}
	Timeout.prototype.unref = Timeout.prototype.ref = function() {};
	Timeout.prototype.close = function() {
	  this._clearFn.call(window, this._id);
	};

	// Does not start the time, just sets up the members needed.
	exports.enroll = function(item, msecs) {
	  clearTimeout(item._idleTimeoutId);
	  item._idleTimeout = msecs;
	};

	exports.unenroll = function(item) {
	  clearTimeout(item._idleTimeoutId);
	  item._idleTimeout = -1;
	};

	exports._unrefActive = exports.active = function(item) {
	  clearTimeout(item._idleTimeoutId);

	  var msecs = item._idleTimeout;
	  if (msecs >= 0) {
	    item._idleTimeoutId = setTimeout(function onTimeout() {
	      if (item._onTimeout)
	        item._onTimeout();
	    }, msecs);
	  }
	};

	// That's not how node.js implements it but the exposed api is the same.
	exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
	  var id = nextImmediateId++;
	  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

	  immediateIds[id] = true;

	  nextTick(function onNextTick() {
	    if (immediateIds[id]) {
	      // fn.call() is faster so we optimize for the common use-case
	      // @see http://jsperf.com/call-apply-segu
	      if (args) {
	        fn.apply(null, args);
	      } else {
	        fn.call(null);
	      }
	      // Prevent ids from leaking
	      exports.clearImmediate(id);
	    }
	  });

	  return id;
	};

	exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
	  delete immediateIds[id];
	};
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(20).setImmediate, __webpack_require__(20).clearImmediate))

/***/ },
/* 21 */
/***/ function(module, exports) {

	// shim for using process in browser

	var process = module.exports = {};
	var queue = [];
	var draining = false;
	var currentQueue;
	var queueIndex = -1;

	function cleanUpNextTick() {
	    draining = false;
	    if (currentQueue.length) {
	        queue = currentQueue.concat(queue);
	    } else {
	        queueIndex = -1;
	    }
	    if (queue.length) {
	        drainQueue();
	    }
	}

	function drainQueue() {
	    if (draining) {
	        return;
	    }
	    var timeout = setTimeout(cleanUpNextTick);
	    draining = true;

	    var len = queue.length;
	    while(len) {
	        currentQueue = queue;
	        queue = [];
	        while (++queueIndex < len) {
	            if (currentQueue) {
	                currentQueue[queueIndex].run();
	            }
	        }
	        queueIndex = -1;
	        len = queue.length;
	    }
	    currentQueue = null;
	    draining = false;
	    clearTimeout(timeout);
	}

	process.nextTick = function (fun) {
	    var args = new Array(arguments.length - 1);
	    if (arguments.length > 1) {
	        for (var i = 1; i < arguments.length; i++) {
	            args[i - 1] = arguments[i];
	        }
	    }
	    queue.push(new Item(fun, args));
	    if (queue.length === 1 && !draining) {
	        setTimeout(drainQueue, 0);
	    }
	};

	// v8 likes predictible objects
	function Item(fun, array) {
	    this.fun = fun;
	    this.array = array;
	}
	Item.prototype.run = function () {
	    this.fun.apply(null, this.array);
	};
	process.title = 'browser';
	process.browser = true;
	process.env = {};
	process.argv = [];
	process.version = ''; // empty string to avoid regexp issues
	process.versions = {};

	function noop() {}

	process.on = noop;
	process.addListener = noop;
	process.once = noop;
	process.off = noop;
	process.removeListener = noop;
	process.removeAllListeners = noop;
	process.emit = noop;

	process.binding = function (name) {
	    throw new Error('process.binding is not supported');
	};

	process.cwd = function () { return '/' };
	process.chdir = function (dir) {
	    throw new Error('process.chdir is not supported');
	};
	process.umask = function() { return 0; };


/***/ },
/* 22 */
/***/ function(module, exports) {

	module.exports = require("lru-cache");

/***/ },
/* 23 */
/***/ function(module, exports) {

	module.exports = require("lodash");

/***/ }
/******/ ]);