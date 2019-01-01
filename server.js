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
var child_process = require('child_process');

// Array of currently connected clients
var clients = [ ];
// JSON list of the current playlist items
var cur_pl_items = {};
// JSON list of the youtube items infos
var yt_items = {};
// Current item
var cur_item = "";
var cur_pos = 0;

// Config data
var config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '/.config/muZic/config.json'), 'utf8'));

process.title = 'muZic';

var zplay = child_process.spawn("stdbuf", ["-oL", "-eL", 'zplay']);

zplay.stdin.write("SHOW_PROGRESS\n");

zplay.stdout.on('data', function(data) {
   var str = data.toString(), lines = str.split(/(\r?\n)/g);
   for (var i=0; i<lines.length; i++)
   {
      if (/POSITION:/g.test(lines[i]))
      {
         var m = lines[i].match(/POSITION: ([0-9]+) \/ ([0-9]+)/);
         var pos = m[1];
         var len = m[2];
         if (cur_pos != pos)
         {
            cur_pos = pos;
            clients.forEach(function(c)
               {
                  c.sendUTF(JSON.stringify({ type:'Player-Progress', pos: pos, len: len }));
               })
         }
      }
   }
});

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

server.listen(webSocketsServerPort, '0.0.0.0', function() {
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

function song_download(item)
{
   var found = false;
   for (let yt_item in yt_items)
   {
      if (yt_item == item) found = true;
   }
   if (!found)
   {
      var path = '/tmp/yt-'+item+'.opus';
      const child = child_process.spawn('youtube-dl',
         ['--audio-format','opus', '--no-part', '-x', 'http://youtube.com/watch?v='+item,
            '-o', path]);
      yt_items[item] = ({path: path, downloading: true, is_playable: false});
      child.stdout.on('data', function(data)
         {
            console.log("ZZZ11"+data+"ZZZ12");
            if (!yt_items[item].is_playable)
            {
               var progress = data.toString().match(/download. ([^%]+)% of/);
               if (progress)
               {
                  if (progress[1] > 10.0)
                  {
                     yt_items[item].is_playable = true;
                     if (item == cur_item)
                     {
                        zplay.stdin.write("FILE "+path+'\n');
                        zplay.stdin.write("PLAY\n");
                     }
                  }

               }
            }
         })
      child.stderr.on('data', function(data)
         {
            console.log("ZZZ21"+data+"ZZZ22");
         })
      child.on('close', function()
         {
            yt_items[item].downloading = false;
            console.log(yt_items[item]);
         })
   }
}

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

                  cur_pl_items = {};
                  rl.on('line', function(line){
                     if (/data-video-id=/g.test(line))
                     {
                        var id = line.match(/data-video-id="([^\"]+)"/);
                        var title = line.match(/data-video-title="([^\"]+)"/);
                        var icon = line.match(/data-thumbnail-url="([^\"]+)"/);
                        cur_pl_items[id[1]] = {title: title[1], icon: icon[1]};
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
         else if (json.type == 'Select-Item')
         {
            console.log('Select item: ' + json.data);
            for (let item in cur_pl_items)
            {
               if (item == json.data)
               {
                  cur_item = json.data;
                  song_download(item);
                  break;
               }
            }
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
