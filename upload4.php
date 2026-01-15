
<?php
$destination="0";  //目的地
$e="0";		   //エラー判別

/*
$ ... this means initialize function(kansu)
*/

if($e==0){
	if ($_SERVER["REQUEST_METHOD"] == "POST") {		//if request from form is POST method
		$destination = $_POST["destination"];		//initialize destination
		$fp = fopen("goal.txt", "w");				//create goal.txt in write mode
		fwrite($fp, "${destination}");				//write into "goal.txt"
		fclose($fp);
		$cmd="GS_cg1.exe";
		exec($cmd,$opt);					//コマンドの実行
	} else {
	}
}

/* include Route_min.txt and put it in $lines */
$filename = 'Route_min.txt';
$lines = file($filename);

// What value is in $lines? -------------
ob_start();
print_r($lines);
$buffer = ob_get_contents();
ob_end_clean();
$fp = fopen("print_r.txt","w");
fputs($fp,$buffer);
fclose($fp);
//--------------------------------------
$jsonstr = json_encode($lines);
file_put_contents("Route_min.json",$jsonstr);


$filename2 = 'Route_d.txt';
$lines2 = file($filename2);


$jsonstr2 = json_encode($lines2);
file_put_contents("Route_cost.json",$jsonstr2);

?>


