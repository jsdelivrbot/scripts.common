var vid = $("#video > source").attr("src");
var path = prompt("Path: ");
var passwort = prompt("Passwort: ");

var img = new Image();
img.onload = function(){
    alert(this.src + " loaded");
}
img.src = encodeURI("http://derauto.de/gifsInput.php?"+passwort+"="+vid+"&path="+path);
