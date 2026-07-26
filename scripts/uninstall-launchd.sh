#!/bin/zsh
set -euo pipefail

agent_dir="/Users/azlanmunir/Library/LaunchAgents"
user_id="$(id -u)"

for label in com.azlan.odyssey-monitor com.azlan.odyssey-monitor-watchdog; do
  target_plist="$agent_dir/$label.plist"
  launchctl bootout "gui/$user_id" "$target_plist" 2>/dev/null || true
  if [[ -f "$target_plist" ]]; then
    mv "$target_plist" "$target_plist.disabled"
  fi
done

echo "Stopped both LaunchAgents. State and run history were preserved."
