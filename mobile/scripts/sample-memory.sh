#!/usr/bin/env bash
# Samples the app's memory counters over adb at a fixed interval and appends a CSV row
# each time. Used to check for leaks across a long-running process.
#
#   scripts/sample-memory.sh [interval-seconds] [output.csv]
#
# Columns: time, pid, process uptime, AppContexts, Proxy Binders, Views, native heap
# allocated (kB), total PSS (kB), swap PSS (kB), location-task jobs handled since the
# previous sample. Doesn't clear logcat.
set -u

PACKAGE=com.neowara.cityroam
INTERVAL=${1:-600}
OUT=${2:-memory-samples.csv}

device_time() {
  adb shell "date '+%m-%d %H:%M:%S.000'" | tr -d '\r'
}

[ -f "$OUT" ] || echo "time,pid,uptime,app_contexts,proxy_binders,views,native_alloc_kb,total_pss_kb,swap_pss_kb,location_jobs" > "$OUT"
since=$(device_time)

while true; do
  now=$(date '+%Y-%m-%d %H:%M:%S')
  pid=$(adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r')
  if [ -z "$pid" ]; then
    echo "$now,,,,,,,,," >> "$OUT"
  else
    mem=$(adb shell dumpsys meminfo "$PACKAGE" 2>/dev/null | tr -d '\r')
    uptime=$(adb shell ps -o ETIME= -p "$pid" 2>/dev/null | tr -d '\r ')
    contexts=$(echo "$mem" | sed -n 's/.*AppContexts: *\([0-9]*\).*/\1/p')
    binders=$(echo "$mem" | sed -n 's/.*Proxy Binders: *\([0-9]*\).*/\1/p')
    views=$(echo "$mem" | sed -n 's/^ *Views: *\([0-9]*\).*/\1/p')
    native=$(echo "$mem" | awk '$1=="Native" && $2=="Heap" && NF>=9 {print $9; exit}')
    pss=$(echo "$mem" | awk '$1=="TOTAL" && NF>=5 {print $2; exit}')
    swap=$(echo "$mem" | awk '$1=="TOTAL" && NF>=5 {print $5; exit}')
    jobs=$(adb logcat -d -T "$since" -s TaskService 2>/dev/null | grep -c "turbo-trip-location-task")
    since=$(device_time)
    echo "$now,$pid,$uptime,$contexts,$binders,$views,$native,$pss,$swap,$jobs" >> "$OUT"
  fi
  sleep "$INTERVAL"
done
