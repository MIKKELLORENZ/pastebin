let selectedPath = null;
let currentBrowsingPath = '';
let parentPath = null;

document.addEventListener('DOMContentLoaded', () => {
  const browseBtn = document.getElementById('browseBtn');
  const directoryBrowser = document.getElementById('directoryBrowser');
  const closeBrowserBtn = document.getElementById('closeBrowserBtn');
  const parentDirBtn = document.getElementById('parentDirBtn');
  const selectCurrentBtn = document.getElementById('selectCurrentBtn');
  const selectedPathInput = document.getElementById('selectedPath');
  const currentBrowsePath = document.getElementById('currentBrowsePath');
  const directoryList = document.getElementById('directoryList');
  const pathInput = document.getElementById('pathInput');
  const goToPathBtn = document.getElementById('goToPathBtn');
  const continueBtn = document.getElementById('continueBtn');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingMessage = document.getElementById('loadingMessage');

  // Browse button
  browseBtn.addEventListener('click', async () => {
    directoryBrowser.classList.remove('hidden');
    await browseDirectory('');
  });

  // Close browser
  closeBrowserBtn.addEventListener('click', () => {
    directoryBrowser.classList.add('hidden');
  });

  // Parent directory button
  parentDirBtn.addEventListener('click', async () => {
    if (parentPath !== null) {
      await browseDirectory(parentPath);
    }
  });

  // Go to specific path
  goToPathBtn.addEventListener('click', async () => {
    const inputPath = pathInput.value.trim();
    if (inputPath) {
      await browseDirectory(inputPath);
    }
  });

  // Enter key in path input
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      goToPathBtn.click();
    }
  });

  // Select current folder button
  selectCurrentBtn.addEventListener('click', () => {
    if (currentBrowsingPath) {
      selectedPath = currentBrowsingPath;
      selectedPathInput.value = currentBrowsingPath;
      directoryBrowser.classList.add('hidden');
      continueBtn.disabled = false;
    }
  });

  // Continue button
  continueBtn.addEventListener('click', async () => {
    if (!selectedPath) {
      alert('Please select a folder first');
      return;
    }
    
    loadingOverlay.classList.remove('hidden');
    loadingMessage.textContent = 'Setting up your upload directory...';
    
    try {
      const response = await fetch('/settings/upload-folder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          path: selectedPath,
          is_setup: true 
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        loadingMessage.textContent = 'Setup complete! Redirecting...';
        
        setTimeout(() => {
          window.location.href = '/';
        }, 1500);
      } else {
        throw new Error(result.message);
      }
      
    } catch (error) {
      loadingOverlay.classList.add('hidden');
      alert('Setup failed: ' + error.message);
    }
  });

  async function browseDirectory(path) {
    pathInput.value = path;
    
    try {
      const response = await fetch('/settings/browse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: path })
      });
      
      const data = await response.json();
      
      if (!data.success) {
        alert('Error: ' + data.message);
        return;
      }
      
      currentBrowsingPath = data.current_path;
      parentPath = data.parent_path;
      currentBrowsePath.textContent = currentBrowsingPath || 'Drives';
      
      // Update parent button state
      parentDirBtn.disabled = parentPath === null;
      
      // Update select current button
      selectCurrentBtn.disabled = !data.current_writable;
      
      // Clear and populate directory list
      directoryList.innerHTML = '';
      
      if (data.items.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'p-4 sm:p-6 text-center text-gray-400 text-sm sm:text-base';
        emptyDiv.textContent = 'This directory is empty or contains no subdirectories';
        directoryList.appendChild(emptyDiv);
        return;
      }
      
      data.items.forEach(item => {
        const itemDiv = document.createElement('div');
        
        // Determine if item should be clickable
        const isClickable = item.readable || item.type === 'drive';
        const clickableClass = isClickable ? 'cursor-pointer hover:bg-gray-800' : 'cursor-not-allowed opacity-50';
        
        itemDiv.className = `p-3 sm:p-4 border-b border-gray-800 flex items-center justify-between transition-colors ${clickableClass}`;
        
        // Choose appropriate icon
        let icon = '📁';
        if (item.type === 'drive') {
          icon = '💾';
        } else if (item.hidden) {
          icon = '📁';
        } else {
          icon = '📂';
        }
        
        const statusText = item.error ? ' (access error)' : '';
        
        // Status indicator and label
        let statusIcon = '';
        let statusLabel = '';
        
        if (item.error && item.type !== 'drive') {
          statusIcon = '<span class="text-red-400">⚠</span>';
          statusLabel = 'Error';
        } else if (item.type === 'drive') {
          statusIcon = '<span class="text-blue-400">→</span>';
          statusLabel = 'Browse';
        } else if (item.has_subdirs) {
          statusIcon = '<span class="text-blue-400">→</span>';
          statusLabel = 'Continue';
        } else if (item.writable) {
          statusIcon = '<span class="text-green-400">✓</span>';
          statusLabel = 'Writable';
        } else {
          statusIcon = '<span class="text-red-400">✗</span>';
          statusLabel = 'Read-only';
        }
        
        itemDiv.innerHTML = `
          <div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <span class="text-lg sm:text-xl flex-shrink-0">${icon}</span>
            <div class="min-w-0 flex-1">
              <div class="text-xs sm:text-sm text-gray-300 truncate">${item.name}${statusText}</div>
              <div class="text-xs text-gray-500">${item.type}</div>
            </div>
          </div>
          <div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <span class="text-xs ${item.type === 'drive' || item.has_subdirs ? 'text-blue-400' : (item.writable ? 'text-green-400' : 'text-gray-500')} hidden sm:inline">${statusLabel}</span>
            ${statusIcon}
          </div>
        `;
        
        // Add click handler for drives and readable directories
        if (isClickable) {
          itemDiv.addEventListener('click', async () => {
            try {
              await browseDirectory(item.path);
            } catch (error) {
              console.error('Failed to browse to:', item.path, error);
              alert(`Failed to access ${item.name}: ${error.message}`);
            }
          });
          
          // Add visual feedback for clickable items
          itemDiv.style.cursor = 'pointer';
        } else {
          itemDiv.style.cursor = 'not-allowed';
        }
        
        directoryList.appendChild(itemDiv);
      });
      
    } catch (error) {
      console.error('Failed to browse directory:', error);
      alert('Failed to browse directory: ' + error.message);
    }
  }
});
