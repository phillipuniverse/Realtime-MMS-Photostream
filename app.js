// Require dependencies
var http = require('http');
var path = require('path');
var express = require('express');
var twilio = require('twilio');
var bodyParser = require('body-parser');
var fs = require('fs');
var mime = require('mime-types');
var requestsModule = require('request');

// Create Express app and HTTP server, and configure socket.io
var app = express();
var server = http.createServer(app);
var io = require('socket.io')(server);

var STATICS_DIR = 'static'

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
          var urlPath = savePath.substr(savePath.indexOf(STATICS_DIR) + STATICS_DIR.length);
          console.log('Finished saving media to ' + savePath + ' notifying listening connections of new media at ' + urlPath);
          io.emit('newMedia', urlPath);
        });
      });
  }
}

io.on('connection', function(socket){
    socket.emit('connected', 'Connected!');
});

server.listen(app.get('port'), function() {
    console.log('Express server listening on *:' + app.get('port'));
});
