#!/bin/bash

echo "🎥 Installing FFmpeg for video processing..."

# Check if FFmpeg is already installed
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg is already installed"
    ffmpeg -version
    exit 0
fi

# Detect OS and install FFmpeg
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    echo "🐧 Installing FFmpeg on Linux..."
    
    # Try apt-get (Ubuntu/Debian)
    if command -v apt-get &> /dev/null; then
        sudo apt-get update
        sudo apt-get install -y ffmpeg
    # Try yum (CentOS/RHEL)
    elif command -v yum &> /dev/null; then
        sudo yum install -y epel-release
        sudo yum install -y ffmpeg
    # Try dnf (Fedora)
    elif command -v dnf &> /dev/null; then
        sudo dnf install -y ffmpeg
    else
        echo "❌ Unsupported Linux distribution. Please install FFmpeg manually."
        exit 1
    fi
    
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "🍎 Installing FFmpeg on macOS..."
    
    # Try Homebrew
    if command -v brew &> /dev/null; then
        brew install ffmpeg
    else
        echo "❌ Homebrew not found. Please install Homebrew first:"
        echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        exit 1
    fi
    
else
    echo "❌ Unsupported operating system: $OSTYPE"
    echo "Please install FFmpeg manually from https://ffmpeg.org/download.html"
    exit 1
fi

# Verify installation
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    echo "📊 FFmpeg version:"
    ffmpeg -version | head -n 1
    
    echo "🔧 Testing FFmpeg with video codecs:"
    ffmpeg -codecs | grep -E "(h264|hevc)"
    
    echo "🚀 FFmpeg is ready for video processing!"
else
    echo "❌ FFmpeg installation failed"
    exit 1
fi

# Create temp directory for video processing
echo "📁 Creating temp directory for video processing..."
mkdir -p /tmp/video-processing
chmod 755 /tmp/video-processing

echo "✅ Setup complete! Your server is ready for video processing."
