echo "copy "$1 $0
targets="gk2a rdr aws"
#targets="aws"
for target in $targets
do
	echo "get flist remote..."
	flist_remote=`ssh sbs@10.10.16.168 ls -1 /data/node_project/weather_data/out_data/$target/$1/*|egrep -v "gz|step10|step5"`
	echo "get flist local..."
	localDir=/d/002.Code/002.node/weather_api/data/weather/$target/$1
	if [ ! -d $localDir ]
	then
		mkdir -p $localDir
	fi
	flist_local=`ls -1 $localDir/*`
	for file in $flist_remote
	do
		fname=`basename ${file}`
		echo "check existence of file" $fname 
		echo $flist_local|grep $fname > /dev/null
		if [ $? -eq 0 ]
		then
			echo "already exists" $target $fname
		else
			echo "copy fname" $target $fname
			scp sbs@10.10.16.168:/data/node_project/weather_data/out_data/$target/$1/$fname $localDir/$fname

		fi
	done
done
#scp sbs@10.10.16.168:/data/node_project/weather_data/out_data/gk2a/$1/* /d/002.Code/002.node/weather_api/data/weather/gk2a/$1
#scp sbs@10.10.16.168:/data/node_project/weather_data/out_data/rdr/$1/* /d/002.Code/002.node/weather_api/data/weather/rdr/$1
