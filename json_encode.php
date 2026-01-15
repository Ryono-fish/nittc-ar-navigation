
<?php
	$route_array = route();
	$textfile = file_get_contents('Route_min.txt');
	$route_array = explode("\n",$textfile);
	
	$jsonstr = json_encode($route_array);
	file_put_contents("Route_min.json",$jsonstr);

?>
