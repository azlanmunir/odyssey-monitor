#!/bin/zsh
set -euo pipefail

project_dir="/Users/azlanmunir/odyssey-monitor"
agent_dir="/Users/azlanmunir/Library/LaunchAgents"
user_id="$(id -u)"

mkdir -p "$agent_dir" "$project_dir/data"
chmod 600 "$project_dir/.env"

for label in com.azlan.odyssey-monitor com.azlan.odyssey-monitor-watchdog; do
  source_plist="$project_dir/launchd/$label.plist"
  target_plist="$agent_dir/$label.plist"
  cp "$source_plist" "$target_plist"
  plutil -lint "$target_plist"
  launchctl bootout "gui/$user_id" "$target_plist" 2>/dev/null || true
  launchctl bootstrap "gui/$user_id" "$target_plist"
done

echo "Installed Odyssey monitor and watchdog LaunchAgents."
echo "No ticket purchase, seat selection, or checkout action is performed."
