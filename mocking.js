function mock(input){
  var rent = "";
  for(var i=0;i < input.length;i++)
    rent = rent + ((Math.random() < Math.random()) ? input[i].toUpperCase() : input[i].toLowerCase());
  return rent;
}
