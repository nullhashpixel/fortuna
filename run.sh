#!/bin/bash
echo "starting..."
sleep 2
while true; do deno task cltunaminer mine; echo "restarting..."; sleep 5; done
