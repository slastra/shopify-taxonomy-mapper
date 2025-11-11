#!/bin/bash

# Shopify Taxonomy Mapper - Systemd Service Installer
# This script installs and configures the systemd service for the taxonomy mapper

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect current directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo -e "${GREEN}Project directory:${NC} $PROJECT_DIR"

# Detect current user
CURRENT_USER="${SUDO_USER:-$USER}"
CURRENT_GROUP="$(id -gn $CURRENT_USER)"
echo -e "${GREEN}Running as user:${NC} $CURRENT_USER:$CURRENT_GROUP"

# Find bun executable
BUN_PATH="$(which bun)"
if [ -z "$BUN_PATH" ]; then
  echo -e "${RED}Error: bun not found in PATH${NC}"
  exit 1
fi
echo -e "${GREEN}Bun executable:${NC} $BUN_PATH"

# Check if .env exists
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo -e "${YELLOW}Warning: .env file not found at $PROJECT_DIR/.env${NC}"
  echo "Make sure to create it before starting the service"
fi

# Service name
SERVICE_NAME="shopify-taxonomy-mapper"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: This script must be run as root (use sudo)${NC}"
  exit 1
fi

# Create the service file
echo -e "${GREEN}Creating systemd service file...${NC}"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Shopify Taxonomy Mapper API
After=network.target
Documentation=https://github.com/slastra/shopify-taxonomy-mapper

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$PROJECT_DIR

# Environment file with secrets
EnvironmentFile=$PROJECT_DIR/.env

# Start command
ExecStart=$BUN_PATH run src/server.ts

# Restart policy
Restart=always
RestartSec=10
StartLimitBurst=3
StartLimitInterval=60

# Resource limits
MemoryMax=1G
CPUQuota=100%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=taxonomy-mapper

# Security hardening (relaxed for Bun compatibility)
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓ Service file created at $SERVICE_FILE${NC}"

# Reload systemd
echo -e "${GREEN}Reloading systemd daemon...${NC}"
systemctl daemon-reload

# Enable the service
echo -e "${GREEN}Enabling service to start on boot...${NC}"
systemctl enable "$SERVICE_NAME"

echo -e "${GREEN}✓ Service installed successfully!${NC}"
echo ""
echo "Useful commands:"
echo "  sudo systemctl start $SERVICE_NAME     # Start the service"
echo "  sudo systemctl stop $SERVICE_NAME      # Stop the service"
echo "  sudo systemctl restart $SERVICE_NAME   # Restart the service"
echo "  sudo systemctl status $SERVICE_NAME    # Check status"
echo "  sudo journalctl -u $SERVICE_NAME -f    # View logs (follow)"
echo ""
echo -e "${YELLOW}Note: Make sure $PROJECT_DIR/.env exists before starting!${NC}"
