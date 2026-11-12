#!/usr/bin/env bash
# Free cloud server for the Pokédex (README: "Run it in the cloud for free").
#
# Run it on a fresh Ubuntu server (an Oracle Cloud "Always Free" VM, a Google Cloud e2-micro, an
# old laptop...), logged in as your normal user, by pasting:
#
#   curl -fsSL https://raw.githubusercontent.com/ksotox/LLMModel/main/scripts/cloud-setup.sh | bash
#
# It installs Node.js 22, the Pokédex launcher as a service that starts with the machine (it keeps
# the app updated from GitHub's main branch, restarts it if it stops and backs the collection up
# every night), and Tailscale, which gives the app a private HTTPS address that only your own
# devices can open. Nothing is opened to the internet. Running it again repairs or updates the setup.
#
# Settings (optional, set before running): POKEDEX_NAME (the server's name on Tailscale, default
# "pokedex"), POKEDEX_PORT (default 3000), POKEDEX_APP_DIR (default ~/LLMModel-main).
set -euo pipefail

REPO=ksotox/LLMModel
RAW="https://raw.githubusercontent.com/$REPO/main"
NAME="${POKEDEX_NAME:-pokedex}"
PORT="${POKEDEX_PORT:-3000}"
APP_DIR="${POKEDEX_APP_DIR:-$HOME/LLMModel-main}"
INSTALL_DIR="$HOME/pokedex"
ME="$(id -un)"

step() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" != 0 ] || fail "Run this as your normal user (for example ubuntu), not as root: it uses sudo where needed."
command -v apt-get >/dev/null || fail "This script is for Ubuntu or Debian."
command -v sudo >/dev/null || fail "sudo is needed."

step "1/5 Node.js 22"
node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 5) ? 0 : 1)'; }
if node_ok; then
  echo "Node.js $(node -v) is already installed."
else
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node_ok || fail "Node.js 22.5 or newer couldn't be installed."
fi

# Small machines (1 GB, like Google's e2-micro) need some swap to install updates.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1900000 ] && ! swapon --show | grep -q .; then
  echo "Adding 2 GB of swap (this machine has little memory)..."
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

step "2/5 The Pokédex launcher, in $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$RAW/desktop/launcher.mjs" -o "$INSTALL_DIR/launcher.mjs.new" && mv "$INSTALL_DIR/launcher.mjs.new" "$INSTALL_DIR/launcher.mjs"
cat > "$INSTALL_DIR/config.json" <<EOF
{ "appDir": "$APP_DIR", "repo": "$REPO", "branch": "main", "port": $PORT, "mode": "server" }
EOF
if [ ! -f "$INSTALL_DIR/pokedex.env" ]; then
  cat > "$INSTALL_DIR/pokedex.env" <<'EOF'
# Settings for your Pokédex server: one NAME=value per line, without quotes.
# After a change, run: sudo systemctl restart pokedex
# POKEMONPRICETRACKER_API_KEY=your-key
EOF
fi
chmod 600 "$INSTALL_DIR/pokedex.env"

step "3/5 Starting it with the machine (service \"pokedex\")"
sudo tee /etc/systemd/system/pokedex.service >/dev/null <<EOF
[Unit]
Description=Pokédex collection server
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$INSTALL_DIR
# Only this machine can reach the server directly: Tailscale passes your devices' requests on.
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=loopback
EnvironmentFile=-$INSTALL_DIR/pokedex.env
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning $INSTALL_DIR/launcher.mjs --server
Restart=always
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable pokedex >/dev/null 2>&1
sudo systemctl restart pokedex
printf 'The first start downloads the app and installs its packages (a few minutes)'
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/meta"; then ok=1; break; fi
  printf '.'; sleep 5
done
echo
[ "${ok:-}" = 1 ] || { tail -n 30 "$INSTALL_DIR/launcher.log" 2>/dev/null || true; fail "The Pokédex didn't start. The lines above (from $INSTALL_DIR/launcher.log) say why."; }
echo "The Pokédex is running on this machine."

step "4/5 Tailscale (your private network)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
echo "If a link appears, open it and sign in with the same account you'll use on your PC and iPhone."
sudo tailscale up --ssh --hostname="$NAME"

step "5/5 Your Pokédex's HTTPS address"
echo "If Tailscale asks you to enable HTTPS for your network, open the link it shows and turn it on."
sudo tailscale serve --bg "$PORT"
DNS="$(tailscale status --json | node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => console.log(JSON.parse(s).Self.DNSName.replace(/\.$/, "")))')"

printf '\n\033[1;32mDone.\033[0m Your Pokédex is at:  \033[1mhttps://%s\033[0m\n' "$DNS"
cat <<EOF

Next:
  1. Install Tailscale on your PC and iPhone (tailscale.com/download), signed in with the same account.
  2. Open https://$DNS: the first visit creates the owner profile (or move your PC's collection first,
     see "Move your collection" in the README).
  3. Make the Pokedex icon on your PC open it: in PowerShell,
       \$env:POKEDEX_REMOTE_URL = "https://$DNS"
       irm https://raw.githubusercontent.com/$REPO/main/desktop/install.ps1 | iex

Useful:  sudo systemctl status pokedex   |   tail -f $INSTALL_DIR/launcher.log
         Settings (e.g. your PokemonPriceTracker key): $INSTALL_DIR/pokedex.env
         Nightly backups: $APP_DIR.backups/
EOF
