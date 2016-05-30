// Require dependencies
var http = require('http');
var path = require('path');
var express = require('express');
var twilio = require('twilio');
var bodyParser = require('body-parser');
var fs = require('fs');
var mime = require('mime-types');
var requestsModule = require('request');
var recursive = require('recursive-readdir');
var instagram = require('instagram-node-lib');

// Create Express app and HTTP server, and configure socket.io
var app = express();
var server = http.createServer(app);
var io = require('socket.io')(server);

var STATICS_DIR = 'static';

var BASE_DOMAIN = process.env.BASE_DOMAIN || 'http://157e7ba9.ngrok.io'

var INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID;
var INSTAGRAM_CLIENT_SECRET = process.env.INSTAGRAM_CLIENT_SECRET;
var INSTAGRAM_CALLBACK_URL = process.env.INSTAGRAM_CALLBACK_URL || BASE_DOMAIN + '/instagram/post';
var INSTAGRAM_OAUTH_REDIRECT_URL = process.env.INSTAGRAM_OAUTH_REDIRECT_URL || BASE_DOMAIN + '/oauth';
var INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
instagram.set('client_id', INSTAGRAM_CLIENT_ID);
instagram.set('client_secret', INSTAGRAM_CLIENT_SECRET);
instagram.set('access_token', INSTAGRAM_ACCESS_TOKEN);
instagram.set('redirect_uri', INSTAGRAM_OAUTH_REDIRECT_URL);

// Middleware to parse incoming HTTP POST bodies
app.use(bodyParser.urlencoded({
    extended: true
}));

// Serve static content from the "static" directory
app.use(express.static(path.join(__dirname, STATICS_DIR)));

// Configure port for HTTP server
app.set('port', process.env.PORT || 3000);

// Handle incoming MMS messages from Twilio
app.post('/message', function(request, response) {
  console.log('Received message.');
  var twiml = twilio.TwimlResponse();
  var numMedia = parseInt(request.body.NumMedia);

  if (numMedia > 0) {
      handleMessage(request, numMedia)
      twiml.message('Photo received - check the screen to see it pop up!');
  } else {
      twiml.message(':( Doesn\'t look like there was a photo in that message.');
  }

  response.type('text/xml');
  response.send(twiml.toString());
});

/**
 * Instagram hits this to make sure that you're actually there
 */
app.get('/subscribe', function(req, res) {
  console.log('Instagram hit the subscription url, responding to challenge');
  res.send(req.query['hub.challenge']);
});

app.get('/oauth_success', function(req, res) {
  console.log(req.params);
  console.log('Succeeded OAuth dance');
  res.send('Thanks! Start uploading pictures with the tag #p&lwedding!');
});

app.get('/instagram', function(req, res) {
  var authUrl = instagram.oauth.authorization_url({
    scope: 'basic public_content',
    display: 'touch'
  });

  res.write('<a href="' + authUrl + '">Click here to start uploading pictures!</a>')
  res.end();
});

app.get('/oauth', function(req, res) {
  instagram.oauth.ask_for_access_token({
    request: req,
    response: res,
    redirect: BASE_DOMAIN + '/oauth_success', // optional
    complete: function(params, response) {
      // params['access_token']
      // params['user']
      console.log('All received params: ' + JSON.stringify(params, null, 2));

    },
    error: function(errorMessage, errorObject, caller, response) {
      // errorMessage is the raised error message
      // errorObject is either the object that caused the issue, or the nearest neighbor
      // caller is the method in which the error occurred
      console.log('Got an error! Oh no!! Here it is: ' + JSON.stringify(errorObject));
    }
  });
});

/**
 * Get the initial set of the images recursively from the file system
 */
function readMediaFiles(req, res, next) {
  var imgDir = path.join(STATICS_DIR, 'img');
  console.log("Reading files from " + imgDir);
  recursive(imgDir, ['placeholder.git'], function(err, files) {
    console.log("Initializing gallery with " + files);

    res.locals.imageNames = [];
    for (var i = 0; i < files.length; i++) {
      res.locals.imageNames.push(getUrlPath(files[i]))
    }

    next();
  });
}

/**
 * Get the initial sset of images already saved on the server
 */
app.get('/initmedia',
  readMediaFiles,
  function(req, res) {
    res.type('application/json');
    res.json(res.locals.imageNames);
  }
);

function handleMessage(mediaRequest, numMedia) {
  // take off the +1 from the phone number, they're all US
  var phoneNumber = mediaRequest.body.From.substr(2);

  var savePath = path.join(STATICS_DIR, 'img/twilio', phoneNumber);
  if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath);
  }

  // Get all the existing files in the save directory, returns an array of filenames
  var existingFileNames = fs.readdirSync(savePath);
  // Add 1 to the length since need to start 1 greater
  var fileNameStart = (existingFileNames) ? existingFileNames.length + 1 : 1

  for (i = 0; i < numMedia; i++) {
    fileNameStart += i;

    var mediaUrl = mediaRequest.body['MediaUrl' + i];
    var mediaType = mediaRequest.body['MediaContentType' + i];
    var ext = mime.extension(mediaType);
    var savePath = path.join(savePath, fileNameStart + '.' + ext);

    console.log('Saving MediaUrl: ' + mediaUrl + ' to path ' + savePath);
    var file = fs.createWriteStream(savePath);

    requestsModule.get(mediaUrl).pipe(file).on('finish', function() {
      file.close(function() {
        var urlPath = getUrlPath(savePath);
        console.log('Finished saving media to ' + savePath + ' notifying listening connections of new media at ' + urlPath);
        io.emit('newMedia', urlPath);
      });
    });
  }
}

function getUrlPath(filePath) {
  return filePath.substr(filePath.indexOf(STATICS_DIR) + STATICS_DIR.length);
}

io.on('connection', function(socket){
    socket.emit('connected', 'Connected!');

    // Now that the socket is connected, start polling instagram for data every couple of seconds
    //setInterval(updateInstagramData, 5000);
});

function updateInstagramData() {
  // Get recent data from the Instagram tag
  instagram.tags.recent({
    name: 'shinergasp',
    complete: function(media_items) {
      if (media_items) {
        console.log('Found ' + media_items.length + ' images for the tag');
      } else {
        console.log('No media found for the given tag');
      }
    },
    error: function(errMessage, err, caller) {
      console.log('Error: ' + errMessage);
    }
  });
}

server.listen(app.get('port'), function() {
    console.log('Express server listening on *:' + app.get('port'));
});
