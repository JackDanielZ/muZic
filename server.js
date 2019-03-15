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
// Current list
var cur_list = "";
// JSON list of the current playlist items
var cur_pl_items = {};
// JSON list of the items infos
var items = {};
// Current item
var cur_item = "";

var cur_pos = 0;
var cur_len = 0;
var cur_state = "PAUSE";

// Config data
var config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '/.muZic/config.json'), 'utf8'));
if (config.Playlists == undefined) config.Playlists = {};

process.title = 'muZic';

var zplay = child_process.spawn("stdbuf", ["-oL", "-eL", 'zplay']);

zplay.stdin.write("SHOW_PROGRESS\n");
zplay.stdin.write("PAUSE_ON_NOTFOUND\n");

function progress_send()
{
   if (cur_item)
   {
      clients.forEach(function(c)
         {
            c.sendUTF(JSON.stringify(
               {
                  opcode:'Player-Progress',
                  list: cur_list,
                  item: cur_item,
                  icon: cur_pl_items[cur_item].icon,
                  state: cur_state,
                  pos: cur_pos,
                  len: cur_len
               }));
         })
   }
}

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
            cur_len = len;
            progress_send();
         }
      }
      else if (/STOPPED/g.test(lines[i]))
      {
         cur_state = 'PAUSE';
         cur_pos = cur_len;
         progress_send();
      }
      else if (/FILE_NOT_FOUND:/g.test(lines[i]))
      {
         var item = lines[i].substring(16);
         console.log(items[item]);
         if (item.is_playable) song_play(item);
         else song_download(item, true);
      }
      else if (/PLAYING:/g.test(lines[i]))
      {
         cur_item = lines[i].substring(9);
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

function song_queue(item, pl_type)
{
   var song_path = "";
   var is_playable = false;
   if (pl_type == "youtube")
   {
      song_path = path.join(os.homedir(), '/.muZic/cache/yt-'+item+'.opus');
   }
   else if (pl_type == "local")
   {
      song_path = path.join(os.homedir(), '/.muZic/cache/'+item+'.opus'),
      is_playable = true;
   }
   if (!items[item])
   {
      items[item] = ({
         path: song_path,
         downloading: false,
         is_playable: is_playable
      });
   }
   zplay.stdin.write("ADD_TO_QUEUE " + item + " " + items[item].path + '\n');
}

function song_play(item)
{
   cur_item = item;
   zplay.stdin.write("PLAY "+item+'\n');
   cur_state = 'PLAY';
}

function song_download(item, to_play)
{
   if (items[item])
   {
      const child = child_process.spawn('youtube-dl',
         ['--audio-format','opus', '--no-part', '-x', 'http://youtube.com/watch?v='+item,
            '-o', items[item].path]);
      items[item].downloading = true;
      child.stdout.on('data', function(data)
         {
            console.log("ZZZ11"+data+"ZZZ12");
            if (!items[item].is_playable)
            {
               var progress = data.toString().match(/download. ([^%]+)% of/);
               if (progress)
               {
                  if (progress[1] > 10.0)
                  {
                     items[item].is_playable = true;
                     if (to_play) song_play(item);
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
            items[item].downloading = false;
            console.log(items[item]);
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
   connection.sendUTF(JSON.stringify({ opcode:'List-Playlists', data: pls_json }));
   connection.sendUTF(JSON.stringify({ opcode:'List-Items', data: cur_pl_items }));
   progress_send();

   // user sent some message
   connection.on('message', function(message) {
      if (message.type === 'utf8')
      { // accept only text
         var json = JSON.parse(message.utf8Data);
         if (json.opcode == 'Select-Playlist')
         {
            var type = config.Playlists[json.data].type;
            cur_list = json.data;
            cur_item = "";
            cur_pos = 0;
            cur_len = 0;
            cur_state = "PAUSE";
            console.log('Select playlist: ' + cur_list);
            console.log(pl);
            console.log("  Type: "+type);
            cur_pl_items = {};
            if (type == "youtube")
            {
               var url="https://www.youtube.com/watch?v="+config.Playlists[cur_list].first_id+"&list="+config.Playlists[cur_list].id;
               console.log(url);
               progress_send();
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
                           cur_pl_items[id[1]] = {title: title[1], icon: icon[1]};
                           song_queue(id[1], type);
                        }
                     })
                     rl.on('close', function()
                        {
                           clients.forEach(function(c)
                              {
                                 c.sendUTF(JSON.stringify({ opcode:'List-Items', data: cur_pl_items }));
                              })
                        })

                  }).on("error", (err) => {
                     console.log("Error: " + err.message);
                  });
            }
            else if (type == "local")
            {
               var pl_items = config.Playlists[json.data].items;
               for (var item in pl_items)
               {
                  cur_pl_items[item] = {title: pl_items[item].title, icon: pl_items[item].icon};
                  song_queue(item, type);
               }
               console.log(cur_pl_items);
               clients.forEach(function(c)
                  {
                     c.sendUTF(JSON.stringify({ opcode:'List-Items', data: cur_pl_items }));
                  })
            }
         }
         else if (json.opcode == 'Add-Playlist')
         {
            if (json.type == 'youtube' && /youtube.com/g.test(json.url))
            {
               var first_id = json.url.match(/v=([a-zA-Z0-9_-]+)/);
               var id = json.url.match(/list=([a-zA-Z0-9_-]+)/);
               config.Playlists[json.name] = { type: "youtube", first_id: first_id[1], id: id[1] };
               pls_json.push({ name: json.name, type: config.Playlists[json.name].type });
               fs.writeFileSync(path.join(os.homedir(), '/.muZic/config.json'),
                  JSON.stringify(config, null, 2));
            }
            else if (json.type == 'local')
            {
               config.Playlists[json.name] = { type: "local" };
               pls_json.push({ name: json.name, type: config.Playlists[json.name].type });
               fs.writeFileSync(path.join(os.homedir(), '/.muZic/config.json'),
                  JSON.stringify(config, null, 2));
            }
            clients.forEach(function(c)
               {
                  c.sendUTF(JSON.stringify({ opcode:'List-Playlists', data: pls_json }));
               })
         }
         else if (json.opcode == 'Select-Item')
         {
            cur_pos = 0;
            cur_len = 0;
            cur_state = "PAUSE";
            progress_send();
            console.log('Select item: ' + json.data);
            song_play(json.data);
         }
         else if (json.opcode == 'Change-Position')
         {
            cur_pos = json.pos;
            zplay.stdin.write("POSITION " + cur_pos + "\n");
            progress_send();
         }
         else if (json.opcode == 'PlayPause')
         {
            if (cur_state == 'PLAY')
            {
               cur_state = 'PAUSE';
               zplay.stdin.write("PAUSE\n");
            }
            else
            {
               cur_state = 'PLAY';
               if (cur_pos == cur_len)
                  zplay.stdin.write("POSITION 0\n");
               zplay.stdin.write("PLAY\n");
            }
            progress_send();
         }
         else if (json.opcode == 'Stop')
         {
            cur_state = 'PAUSE';
            zplay.stdin.write("STOP\n");
            cur_pos = "0";
            progress_send();
         }
         else if (json.opcode == 'Next')
         {
            cur_state = 'PLAY';
            zplay.stdin.write("NEXT\n");
            cur_pos = "0";
            progress_send();
         }
         else if (json.opcode == 'Prev')
         {
            cur_state = 'PLAY';
            zplay.stdin.write("PREV\n");
            cur_pos = "0";
            progress_send();
         }
         else if (json.opcode == 'Loop')
         {
            if (json.state == true)
               zplay.stdin.write("LOOP ON\n");
            else
               zplay.stdin.write("LOOP OFF\n");
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
