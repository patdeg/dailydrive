#!/bin/bash
# =============================================================================
# Daily Drive — Quick Installer
# =============================================================================
# Run this once to set everything up on your machine.
#
# Usage:  chmod +x install.sh && ./install.sh
# =============================================================================

set -e

echo ""
echo "Daily Drive — Installer"
echo "=========================="
echo ""

# --- Check for Node.js ---
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "Node.js installed: $(node --version)"
else
    NODE_VERSION=$(node --version)
    echo "Node.js found: $NODE_VERSION"

    # Check minimum version (v18+)
    MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -lt 18 ]; then
        echo "WARNING: Node.js v18+ required (found $NODE_VERSION)"
        echo "Update with: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
        exit 1
    fi
fi

# --- Install dependencies ---
echo ""
echo "Installing dependencies..."
npm install
echo "Dependencies installed"

# --- Create config if needed ---
if [ ! -f config.yaml ]; then
    cp config.example.yaml config.yaml
    echo ""
    echo "Created config.yaml from template"
    echo "   Edit it now:  nano config.yaml"
else
    echo ""
    echo "config.yaml already exists"
fi

echo ""
echo "=========================="
echo "Installation complete!"
echo "=========================="
echo ""
echo "Next steps:"
echo "  1. Create a Spotify app at https://developer.spotify.com/dashboard"
echo "     - Set redirect URI to: http://127.0.0.1:8888/callback"
echo "     - Enable Web API and Web Playback SDK"
echo "     - Add your Spotify email in Settings > User Management"
echo "  2. Edit config.yaml with your Spotify credentials and preferences"
echo "  3. Run: npm run setup    (one-time Spotify login)"
echo "  4. Run: npm start        (build your playlist!)"
echo "  5. Optional: Set up auto-refresh (see README.md)"
echo ""
