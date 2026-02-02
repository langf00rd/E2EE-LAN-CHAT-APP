rm -rf out && ncc build apps/server/index.js -o out
cp node.tar.gz out
cp start.sh out
