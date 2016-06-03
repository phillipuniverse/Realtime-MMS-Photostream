// Require dependencies
var http = require('http');
var path = require('path');
var url = require('url');
var express = require('express');
var twilio = require('twilio');
var bodyParser = require('body-parser');
var fs = require('fs');
var mime = require('mime-types');
var requestsModule = require('request');
var recursive = require('recursive-readdir');
var instagram = require('instagram-node-lib');
var storage = require('node-persist');

// TODO:
//  Fix button display for OAuth when on mobile; big button press
//  Add some sort of moderation for bad images?
//  See what happens with like 100 images
//  Save smaller versions of the images so that they don't take so long to load

// Create Express app and HTTP server, init and configure socket.io, initialize storage
var app = express();
var server = http.createServer(app);
var io = require('socket.io')(server);
storage.initSync();

var STATICS_DIR = 'static';

var BASE_DOMAIN = process.env.BASE_DOMAIN || 'https://157e7ba9.ngrok.io'

var INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID;
var INSTAGRAM_CLIENT_SECRET = process.env.INSTAGRAM_CLIENT_SECRET;
var INSTAGRAM_CALLBACK_URL = process.env.INSTAGRAM_CALLBACK_URL || BASE_DOMAIN + '/instagram/post';
var INSTAGRAM_OAUTH_REDIRECT_URL = process.env.INSTAGRAM_OAUTH_REDIRECT_URL || BASE_DOMAIN + '/oauth';
var INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
instagram.set('client_id', INSTAGRAM_CLIENT_ID);
instagram.set('client_secret', INSTAGRAM_CLIENT_SECRET);
instagram.set('access_token', INSTAGRAM_ACCESS_TOKEN);
// OAuth redirect
instagram.set('redirect_uri', INSTAGRAM_OAUTH_REDIRECT_URL);

// Subscription callback
instagram.set('callback_url', INSTAGRAM_CALLBACK_URL);

// Middleware to parse incoming HTTP POST bodies for Twilio
app.use(bodyParser.urlencoded({
    extended: true
}));

// Middleware to parse POST bodies with JSON
app.use(bodyParser.json());

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
      handleTwilioMessage(request, numMedia)
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
app.get('/instagram/post', function(req, res) {
  console.log('Instagram hit the subscription url, challenge accepted!');
  instagram.subscriptions.handshake(req, res);
});

/**
 * Instagram hits this URL every time a user posts with JSON that looks like:
 *     {
        "changed_aspect": "media",
        "object": "user",
        "object_id": "<string user's id>",
        "time": 1464581524, //unix timestamp
        "subscription_id": 0,
        "data": {
            "media_id": "<string media id>"
        }
    }
 */
app.post('/instagram/post', function(req, res) {
  var imageJson = req.body[0];
  console.log('A user uploaded a picture! Here is the data we got: ' + JSON.stringify(imageJson, null, 2));

  // use the given user ID grab their saved access token, use that to download their uploaded image
  var userId = imageJson.object_id;
  console.log('Looking up a persisted user via their userId key: ' + userId)
  var persistedUser = storage.getItem(userId);
  var accessToken = persistedUser.accessToken;
  if (!accessToken) {
    console.log('Could not find a user record for the given user ' + userId + '. Using preconfigured token instead');
    accessToken = INSTAGRAM_ACCESS_TOKEN;
  }

  var mediaId = imageJson.data.media_id;
  console.log('Querying instagram for media: ' + mediaId + ' with the access token ' + accessToken + ' for user ' + persistedUser.username);
  instagram.media.info({
    access_token: accessToken,
    media_id: mediaId,
    complete: function(data) {
        // For the spec on the JSON that gets returned here, see https://www.instagram.com/developer/endpoints/media/
        console.log('Here is all the data about the given media: ' + data);
        var tags = data.tags;
        console.log('Found these tags for the given image: ' + tags);
        var tagFilter = false;
        // Go through each of the tags that I'm looking for and make sure the item
        // has at least one of them
        for (var i = 0; i < INSTAGRAM_SEARCH_TAGS.length && !tagFilter; i++) {
          tagFilter = tags.indexOf(INSTAGRAM_SEARCH_TAGS[i]) > -1;
        }
        if (!tagFilter) {
          console.log('The uploaded image did not contain any of the tags we were looking for');
          return;
        }

        // The image is good, let's save it!
        console.log('We found a tag we were looking for, saving the image locally');
        var standardResUrl = data.images.standard_resolution.url;

        var media = parseInstagramMediaUrl(standardResUrl);
        var persistedUser = storage.getItem(userId);
        var savePath = path.join(STATICS_DIR, 'img/instagram', persistedUser.username);
        saveImages(savePath, [media]);

      }
    });

    res.sendStatus(200);
    // We've already seen this media so don't screw with it again. Sometimes instagram likes
    // to hit the endpoint multiple times
});

/**
 * Parses out the media URL that we get from Instagram and gives us back something suitable
 * to pass along to saveImages()
 */
function parseInstagramMediaUrl(instagramImgUrl) {
  // Doing something special here because there is a query string on the end of the
  // file name for the ig_cache_key. This cache key can have a . in it
  var ext = path.extname(url.parse(instagramImgUrl).pathname);
  return {
    url: instagramImgUrl,
    // Strip out the leading period
    ext: ext.substr(1)
  };
}

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
      /* Data comes back in params looking like this:
       * {
            "access_token": "123456.75839fa.45d8d838d9f8ac3848",
            "user": {
              "username": "someuser",
              "bio": "",
              "website": "",
              "profile_picture": "<profile_url>",
              "full_name": "John Doe",
              "id": "123456"
          }
        }
       */
      console.log('OAuth received params: ' + JSON.stringify(params, null, 2));

      var userId = params.user.id;
      var username = params.user.username;
      var accessToken = params.access_token;

      var persistedUser = {
        username: username,
        accessToken: accessToken
      }
      console.log('Persisting ' + userId + ' with access token ' + accessToken + ' for later use');
      storage.setItem(userId, persistedUser);
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

function handleTwilioMessage(mediaRequest, numMedia) {
  // take off the +1 from the phone number, they're all US
  var phoneNumber = mediaRequest.body.From.substr(2);

  var savePath = path.join(STATICS_DIR, 'img/twilio', phoneNumber);
  var media = [];
  for (var i = 0; i < numMedia; i++) {
    media.push({
      url: mediaRequest.body['MediaUrl' + i],
      type: mediaRequest.body['MediaContentType' + i]
    });
  }
  saveImages(savePath, media);
}

/*
 * savePath - where the image should be saved to
 * mediaUrls - List of objects of the form {url = 'http://....', ext='.jpg', type='image/jpeg'}. The
 *    extension part is appended to the end of the file as it is saved on the local filesystem
 */
function saveImages(baseSaveDir, medias) {
  if (!fs.existsSync(baseSaveDir)) {
    fs.mkdirSync(baseSaveDir);
  }

  // Get all the existing files in the save directory, returns an array of filenames
  var existingFileNames = fs.readdirSync(baseSaveDir);
  // Add 1 to the length since need to start 1 greater
  var existingFileCount = existingFileNames.length;
  var fileNameStartNum = existingFileNames.length + 1;
  console.log("Found " + existingFileCount + " files in " + baseSaveDir + " starting at file number " + fileNameStartNum);

  for (var i = 0; i < medias.length; i++) {
    var mediaUrl = medias[i].url;
    var ext = medias[i].ext;
    if (!ext) {
      var mediaType = medias[i].type;
      ext = mime.extension(mediaType);
    }
    var savePath = path.join(baseSaveDir, fileNameStartNum + '.' + ext);

    console.log('Saving MediaUrl: ' + mediaUrl + ' to path ' + savePath);
    var file = fs.createWriteStream(savePath);

    requestsModule.get(mediaUrl).pipe(file).on('finish', function() {
      file.close(function() {
        var urlPath = getUrlPath(savePath);
        console.log('Finished saving media to ' + savePath + ' notifying listening connections of new media at ' + urlPath);
        io.emit('newMedia', urlPath);
      });
    });
    // Don't forget to get the new file number!
    fileNameStartNum++;
  }
}

function getUrlPath(filePath) {
  return filePath.substr(filePath.indexOf(STATICS_DIR) + STATICS_DIR.length);
}

io.on('connection', function(socket){
    socket.emit('connected', 'Connected!');

    // Now that the socket is connected, start polling instagram for data every couple of seconds
    setInterval(pollInstagramData, 5000);
});

function pollInstagramData() {
  var newestImagesId = storage.getItem('newest_images_id');

  // Get recent data from the Instagram tag
  instagram.tags.recent({
    name: 'shinergasp',
    // only get images that were uploaded after the last time we checked
    min_tag_id: newestImagesId,
    complete: function(data, pagination) {
      if (data.length) {
        console.log('Found ' + data.length + ' images for the tag');
      } else {
        console.log('No recent images found for the given tag');
        return;
      }

      // Next time we poll, make sure to pass this in so we don't get back duplicate images
      storage.setItem('newest_images_id', pagination.min_tag_id);

      // Compile a map of all the media keyed by where to save them since multiple users
      // could have uploaded within a single page
      var imagesToSave = {};
      for (var i = 0; i < data.length; i++) {
        var media = data[i];
        if (media.type == "image") {
          var imgUrl = media.images.standard_resolution.url;
          var savePath = path.join(STATICS_DIR, 'img/instagram', media.user.username);
          // Throw this into a map keyed by the save path because multiple user uploads
          // could have existed in the same page
          console.log("Parsed out an image from " + media.user.username);
          if (!imagesToSave[savePath]) {
            imagesToSave[savePath] = [];
          }
          imagesToSave[savePath].push(parseInstagramMediaUrl(imgUrl));
        }
      }

      for (var savePath in imagesToSave) {
        if (!imagesToSave.hasOwnProperty(savePath)) { continue; }
        saveImages(savePath, imagesToSave[savePath]);
      }
    },
    error: function(errMessage, err, caller) {
      console.log('Error loading recent images from tag: ' + errMessage);
    }
  });
}

server.listen(app.get('port'), function() {
    console.log('Express server listening on *:' + app.get('port'));

    if (process.env.SUBSCRIBE) {
      console.log('Re-subscribing to all authenticated user posts');
      var unsubResult = instagram.users.unsubscribe_all({});
      if (unsubResult) {
        console.log('There was an error in removing exising subscriptions: ' + unsubResult);
      }

      instagram.users.subscribe({});
    }
});
