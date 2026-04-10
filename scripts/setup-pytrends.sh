#!/bin/bash

echo "Setting up pytrends..."

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is not installed. Please install Python 3 first."
    exit 1
fi

# Install pytrends
echo "Installing pytrends via pip..."
python3 -m pip install --user pytrends

echo "Done! pytrends is installed."
