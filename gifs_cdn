var vid = $("#video > source").attr("src");
var path = prompt("Path: ");
var passwort = prompt("Passwort: ");


var sender;
if (window.XMLHttpRequest){
  sender = new XMLHttpRequest();
  sender.open("GET", encodeURI("https://derauto.de/gifsInput.php?"+passwort+"="+vid+"&path="+path) , false);
  sender.send(null);
}
  
