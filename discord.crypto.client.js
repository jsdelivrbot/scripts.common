function serverChannelHeader(){
	if(window.location.pathname.includes("/channels/")){
		sub = window.location.pathname.substring("/channels/".length);
		subA = false; subB = false;
		if(sub.includes("/")){
			subA = sub.substring(0,sub.indexOf("/"));
			if(subA == "@me") subA = false;
			if(subA == false) subB = sub.substring("@me".length + 1); else subB = sub.substring(subA.length + 1);
		}else{
			subA = sub != "@me";
		}
		return [subA,subB];
	}
	return [false,false];
}

var oldTextArea = document.getElementsByTagName("textarea")[0];
var newTextArea = document.createElement("textarea");
newTextArea.setAttribute("placeholder",oldTextArea.getAttribute("placeholder"));
newTextArea.setAttribute("rows",oldTextArea.getAttribute("rows"));
newTextArea.setAttribute("class",oldTextArea.getAttribute("class"));
newTextArea.setAttribute("style",oldTextArea.getAttribute("style"));
newTextArea.setAttribute("id","cryptMeInput");
oldTextArea.setAttribute("id","rawInput");
function cryptHandler(text,target){
	console.log("[CryptoCord] Queueing ("+text.length+") to ",target);
}
function keyHandler(e){
   if (e.which === 13) {
        if (e.shiftKey == false) {
			e.preventDefault();
            cryptHandler(newTextArea.value,serverChannelHeader());
			newTextArea.value="";
        }
    }
}
newTextArea.addEventListener("keydown",keyHandler);

oldTextArea.style.display = "none";
oldTextArea.parentElement.appendChild(newTextArea);
