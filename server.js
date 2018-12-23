// http://ejohn.org/blog/ecmascript-5-strict-mode-json-and-more/
"use strict";


// Port where we'll run the websocket server
var webSocketsServerPort = 1337;

var webSocketServer = require('websocket').server;
var http = require('http');
var https = require('https');
var readline = require('readline');
var fs = require('fs');
var path = require('path');
var os = require('os');

// list of currently connected clients (users)
var clients = [ ];
// list of the current playlist items
var cur_pl_items = [];
// Config data
var config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '/.config/muZic/config.json'), 'utf8'));

process.title = 'muZic';

for (var pl in config.Playlists)
{
   var type = config.Playlists[pl].type;
   console.log(pl);
   console.log("  Type: "+type);
   if (type == "youtube")
   {
      console.log("  Id: "+config.Playlists[pl].id)
      console.log("  First-Id: "+config.Playlists[pl].first_id);
   }
}

/**
 * HTTP server
 */
var server = http.createServer(function(request, response) {
   fs.readFile('./frontend.html', function (err, data) {
      if (err) {
         response.writeHead(404);
         response.write('Contents you are looking are Not Found');
      } else {
         response.writeHead(200, {'Content-Type': 'text/html'});
         response.write(data);
      }
      response.end(); 
   });
});

server.listen(webSocketsServerPort, function() {
   console.log((new Date()) + " Server is listening on port " + webSocketsServerPort);
});

/**
 * WebSocket server
 */
var wsServer = new webSocketServer({
   // WebSocket server is tied to a HTTP server. WebSocket request is just
   // an enhanced HTTP request. For more info http://tools.ietf.org/html/rfc6455#page-6
   httpServer: server
});

// This callback function is called every time someone
// tries to connect to the WebSocket server
wsServer.on('request', function(request) {
   console.log((new Date()) + ' Connection from origin ' + request.origin + '.');

   var connection = request.accept(null, request.origin); 
   var pls_json = [];

   clients.push(connection);
   for (var pl in config.Playlists)
      pls_json.push({ name: pl, type: config.Playlists[pl].type });
   connection.sendUTF(JSON.stringify({ type:'List-Playlists', data: pls_json }));
   connection.sendUTF(JSON.stringify({ type:'List-Items', data: cur_pl_items }));

   console.log((new Date()) + ' Connection accepted.');

   // user sent some message
   connection.on('message', function(message) {
      if (message.type === 'utf8')
      { // accept only text
         var json = JSON.parse(message.utf8Data);
         if (json.type == 'Select-Playlist')
         {
            console.log('Select playlist: ' + json.data);
            var url="https://www.youtube.com/watch?v="+config.Playlists[json.data].first_id+"&list="+config.Playlists[json.data].id;
            console.log(url);
            https.get(url, function(resp)
               {
                  var rl = readline.createInterface({
                     input: resp,
                     output: process.stdout,
                     terminal: false
                  });

                  rl.on('line', function(line){
                     if (/data-video-id=/g.test(line))
                     {
                        var id = line.match(/data-video-id="([^\"]+)"/);
                        var title = line.match(/data-video-title="([^\"]+)"/);
                        var icon = line.match(/data-thumbnail-url="([^\"]+)"/);
                        cur_pl_items.push({id: id[1], title: title[1], icon: icon[1]});
                     }
                  })
                  rl.on('close', function()
                  {
                     clients.forEach(function(c)
                        {
                           c.sendUTF(JSON.stringify({ type:'List-Items', data: cur_pl_items }));
                        })
                  })

               }).on("error", (err) => {
                  console.log("Error: " + err.message);
               });
         }
      }
   });

   // user disconnected
   connection.on('close', function(connection) {
      console.log((new Date()) + " Peer "
         + connection.remoteAddress + " disconnected.");
      clients.splice(clients.indexOf(connection), 1);
   });

});
