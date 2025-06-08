/* ---------- helpers ---------- */
const debounce = (fn, ms = 500) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
};

/* ---------- PERIODIC FILE CHECKING ---------- */
let periodicCheckInterval = null;
let lastCleanupCount = 0;

function initPeriodicFileCheck() {
  // Check for missing files every 2 seconds
  periodicCheckInterval = setInterval(async () => {
    try {
      const response = await fetch('/admin/check-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      const result = await response.json();
      
      if (result.success && result.cleanup_count > 0) {
        // Files were found missing and cleaned up
        console.log(`Automatic cleanup: ${result.cleanup_count} missing files detected and removed`);
        
        // Show a subtle notification
        showNotification(`${result.cleanup_count} missing files were automatically removed`, 'info');
        
        // Automatically refresh the paste list without full page reload
        await refreshPasteList();
        
        // Update the cleanup count to prevent repeated notifications
        lastCleanupCount = result.cleanup_count;
      }
    } catch (error) {
      // Silently handle errors to avoid spam
      console.error('Periodic file check error:', error);
    }
  }, 2000); // Check every 2 seconds
}

async function refreshPasteList() {
  try {
    // Get current search parameters
    const searchBox = document.getElementById("searchBox");
    const q = searchBox ? searchBox.value : '';
    const dateRange = window.getCurrentDateRange ? window.getCurrentDateRange() : { start: '', end: '' };
    
    const params = new URLSearchParams({
      partial: '1',
      q: q,
      start_date: dateRange.start,
      end_date: dateRange.end
    });
    
    const res = await fetch(`/?${params}`);
    if (res.ok) {
      const data = await res.json();
      document.getElementById("pasteList").innerHTML = data.list;
      document.getElementById("pagination").innerHTML = data.pagination;
      
      // Clear selections after refresh since items may have been removed
      selectedItems.clear();
      document.querySelectorAll('.bulk-select').forEach(cb => cb.checked = false);
      updateBulkActionsAfterDelete();
      
      // Reattach event listeners to new elements
      attachItemListeners();
    }
  } catch (error) {
    console.error('Failed to refresh paste list:', error);
  }
}

function showNotification(message, type = 'info') {
  // Create a simple notification
  const notification = document.createElement('div');
  notification.className = `fixed top-20 right-4 z-50 p-3 rounded-lg shadow-lg transition-all duration-300 transform translate-x-full ${
    type === 'info' ? 'bg-blue-600' : 
    type === 'success' ? 'bg-green-600' : 
    type === 'warning' ? 'bg-orange-600' : 'bg-red-600'
  } text-white text-sm max-w-sm`;
  
  notification.innerHTML = `
    <div class="flex items-center gap-2">
      <svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zm-4 4a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
      </svg>
      <span>${message}</span>
    </div>
  `;
  
  document.body.appendChild(notification);
  
  // Animate in
  setTimeout(() => {
    notification.style.transform = 'translateX(0)';
  }, 100);
  
  // Auto remove after 3 seconds
  setTimeout(() => {
    notification.style.transform = 'translateX(full)';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

function stopPeriodicFileCheck() {
  if (periodicCheckInterval) {
    clearInterval(periodicCheckInterval);
    periodicCheckInterval = null;
  }
}

/* ---------- COPY (with fallback) ---------- */
function handleCopy(btn) {
  btn.addEventListener("click", async e => {
    e.stopPropagation();
    const id = btn.dataset.id;
    try {
      const res = await fetch(`/raw/${id}`);
      if (!res.ok) throw new Error("fetch failed");
      const text = await res.text();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        /* fallback for HTTP or old browsers */
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy");
        document.body.removeChild(ta);
      }
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    } catch (err) {
      alert("Copy failed: " + err.message);
    }
  });
}

/* ---------- DELETE (AJAX) ---------- */
function handleDelete(btn) {
  btn.addEventListener("click", async e => {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("Delete this paste?")) return;
    const item = btn.closest("div[id^='item-']");
    const pasteId = btn.dataset.id;
    
    try {
      const res = await fetch(`/delete/${btn.dataset.id}`, {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      });
      if (res.status === 204) {
        item.style.transform = "scale(0)";
        item.style.opacity = "0";
        setTimeout(() => {
          item.remove();
          
          // Update bulk selection state if item was selected
          if (selectedItems.has(pasteId)) {
            selectedItems.delete(pasteId);
            updateBulkActionsAfterDelete();
          }
        }, 300);
      } else {
        location.reload();
      }
    } catch {
      location.reload();
    }
  });
}

let selectedItems = new Set();

/* ---------- DRAG AND DROP ---------- */
function initDragDrop() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  
  // Only enable on desktop
  if (window.innerWidth < 768) {
    const desktopOnly = document.querySelector('.desktop-only');
    if (desktopOnly) desktopOnly.style.display = 'none';
    return;
  }

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, highlight, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, unhighlight, false);
  });

  dropZone.addEventListener('drop', handleDrop, false);

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function highlight() {
    dropZone.classList.add('bg-blue-900/20');
  }

  function unhighlight() {
    dropZone.classList.remove('bg-blue-900/20');
  }

  function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    fileInput.files = files;
  }
}

/* ---------- DATE RANGE PICKER ---------- */
function initDateRangePicker() {
  const dateRangeInput = document.getElementById('dateRange');
  
  // Initialize with current values from URL params
  const urlParams = new URLSearchParams(window.location.search);
  const startDate = urlParams.get('start_date') || '';
  const endDate = urlParams.get('end_date') || '';
  
  let currentStartDate = startDate;
  let currentEndDate = endDate;
  
  updateDateRangeDisplay();

  // Initialize Flatpickr with range mode
  const fp = flatpickr(dateRangeInput, {
    mode: "range",
    theme: "dark",
    dateFormat: "Y-m-d",
    defaultDate: startDate && endDate ? [startDate, endDate] : [],
    onChange: function(selectedDates, dateStr, instance) {
      if (selectedDates.length === 2) {
        currentStartDate = instance.formatDate(selectedDates[0], "Y-m-d");
        currentEndDate = instance.formatDate(selectedDates[1], "Y-m-d");
      } else if (selectedDates.length === 1) {
        currentStartDate = instance.formatDate(selectedDates[0], "Y-m-d");
        currentEndDate = '';
      } else {
        currentStartDate = '';
        currentEndDate = '';
      }
      updateDateRangeDisplay();
      doSearch();
    },
    onClose: function(selectedDates, dateStr, instance) {
      // Ensure search is triggered when calendar closes
      doSearch();
    }
  });

  function updateDateRangeDisplay() {
    if (currentStartDate && currentEndDate) {
      dateRangeInput.value = `${currentStartDate} - ${currentEndDate}`;
    } else if (currentStartDate) {
      dateRangeInput.value = `From ${currentStartDate}`;
    } else if (currentEndDate) {
      dateRangeInput.value = `Until ${currentEndDate}`;
    } else {
      dateRangeInput.value = '';
      dateRangeInput.placeholder = 'Date range';
    }
  }

  // Add a clear button functionality
  dateRangeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Delete') {
      fp.clear();
      currentStartDate = '';
      currentEndDate = '';
      updateDateRangeDisplay();
      doSearch();
    }
  });

  // Store references for the search function
  window.getCurrentDateRange = () => ({
    start: currentStartDate,
    end: currentEndDate
  });
}

/* ---------- BULK SELECTION ---------- */
function initBulkSelection() {
  const bulkActions = document.getElementById('bulkActions');
  const selectedCountEl = document.getElementById('selectedCount');
  const bulkDownload = document.getElementById('bulkDownload');
  const bulkDelete = document.getElementById('bulkDelete');
  const clearSelection = document.getElementById('clearSelection');
  const bulkActionBar = document.getElementById('bulkActionBar');
  const selectedList = document.getElementById('selectedList');
  const selectedItemsEl = document.getElementById('selectedItems');
  const expandArrow = document.getElementById('expandArrow');

  function updateBulkActions() {
    if (selectedItems.size > 0) {
      bulkActions.classList.remove('hidden');
      selectedCountEl.textContent = selectedItems.size;
      updateSelectedList();
    } else {
      bulkActions.classList.add('hidden');
      selectedList.classList.add('hidden');
      expandArrow.style.transform = 'rotate(0deg)';
    }
  }

  // New function to handle bulk actions update after individual deletion
  window.updateBulkActionsAfterDelete = function() {
    updateBulkActions();
  };

  function updateSelectedList() {
    selectedItemsEl.innerHTML = '';
    selectedItems.forEach(id => {
      const card = document.querySelector(`[data-paste-id="${id}"]`);
      if (card) {
        const filename = card.dataset.filename;
        const isFile = card.dataset.isFile === '1';
        const title = filename || (isFile ? 'File' : 'Text paste');
        
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between bg-gray-900 p-2 rounded text-sm';
        item.innerHTML = `
          <span class="text-gray-300 truncate">${title}</span>
          <button class="remove-selection text-red-400 hover:text-red-300 ml-2" data-id="${id}">×</button>
        `;
        selectedItemsEl.appendChild(item);
      }
    });
  }

  function updateCardVisuals(id, selected) {
    const card = document.querySelector(`[data-paste-id="${id}"]`);
    if (card) {
      if (selected) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    }
  }

  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('bulk-select')) {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        selectedItems.add(id);
        updateCardVisuals(id, true);
      } else {
        selectedItems.delete(id);
        updateCardVisuals(id, false);
      }
      updateBulkActions();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-selection')) {
      const id = e.target.dataset.id;
      selectedItems.delete(id);
      const checkbox = document.querySelector(`.bulk-select[data-id="${id}"]`);
      if (checkbox) checkbox.checked = false;
      updateCardVisuals(id, false);
      updateBulkActions();
    }
  });

  // Make the entire bar clickable to expand/collapse
  bulkActionBar.addEventListener('click', (e) => {
    // Don't toggle if clicking on buttons
    if (e.target.closest('button')) return;
    
    if (selectedList.classList.contains('hidden')) {
      selectedList.classList.remove('hidden');
      expandArrow.style.transform = 'rotate(180deg)';
    } else {
      selectedList.classList.add('hidden');
      expandArrow.style.transform = 'rotate(0deg)';
    }
  });

  clearSelection.addEventListener('click', () => {
    selectedItems.forEach(id => updateCardVisuals(id, false));
    selectedItems.clear();
    document.querySelectorAll('.bulk-select').forEach(cb => cb.checked = false);
    updateBulkActions();
  });

  bulkDownload.addEventListener('click', async () => {
    if (selectedItems.size === 0) return;
    
    try {
      const res = await fetch('/bulk-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedItems) })
      });
      
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // Get filename from Content-Disposition header
        const contentDisposition = res.headers.get('Content-Disposition');
        let filename = `pastebin_bulk_${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}.zip`;
        
        if (contentDisposition) {
          const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          if (filenameMatch && filenameMatch[1]) {
            filename = filenameMatch[1].replace(/['"]/g, '');
          }
        }
        
        a.download = filename;
        a.click();
        window.URL.revokeObjectURL(url);
      } else {
        alert('Download failed');
      }
    } catch (err) {
      alert('Download failed: ' + err.message);
    }
  });

  // Updated bulk delete with confirmation modal
  bulkDelete.addEventListener('click', async () => {
    if (selectedItems.size === 0) return;
    
    // Show confirmation modal instead of simple confirm
    showBulkDeleteModal();
  });
}

/* ---------- BULK DELETE CONFIRMATION MODAL ---------- */
function initBulkDeleteModal() {
  const bulkDeleteModal = document.getElementById('bulkDeleteModal');
  const deleteCountEl = document.getElementById('deleteCount');
  const deleteConfirmInput = document.getElementById('deleteConfirmInput');
  const cancelBulkDelete = document.getElementById('cancelBulkDelete');
  const confirmBulkDelete = document.getElementById('confirmBulkDelete');

  function showBulkDeleteModal() {
    deleteCountEl.textContent = selectedItems.size;
    deleteConfirmInput.value = '';
    confirmBulkDelete.disabled = true;
    bulkDeleteModal.classList.remove('hidden');
    
    // Focus on input after modal is shown
    setTimeout(() => {
      deleteConfirmInput.focus();
    }, 100);
  }

  // Make showBulkDeleteModal globally available
  window.showBulkDeleteModal = showBulkDeleteModal;

  function hideBulkDeleteModal() {
    bulkDeleteModal.classList.add('hidden');
    deleteConfirmInput.value = '';
    confirmBulkDelete.disabled = true;
  }

  // Input validation
  deleteConfirmInput.addEventListener('input', (e) => {
    const value = e.target.value.trim();
    confirmBulkDelete.disabled = value !== 'DELETE';
  });

  // Enter key handling
  deleteConfirmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !confirmBulkDelete.disabled) {
      confirmBulkDelete.click();
    } else if (e.key === 'Escape') {
      hideBulkDeleteModal();
    }
  });

  // Cancel button
  cancelBulkDelete.addEventListener('click', hideBulkDeleteModal);

  // Close on backdrop click
  bulkDeleteModal.addEventListener('click', (e) => {
    if (e.target === bulkDeleteModal) {
      hideBulkDeleteModal();
    }
  });

  // Confirm delete
  confirmBulkDelete.addEventListener('click', async () => {
    if (deleteConfirmInput.value.trim() !== 'DELETE') return;
    
    hideBulkDeleteModal();
    
    try {
      const res = await fetch('/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedItems) })
      });
      
      // Check if the response is actually JSON
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        // If we get HTML instead of JSON, it's likely an error page
        const errorText = await res.text();
        console.error('Server returned HTML instead of JSON:', errorText);
        throw new Error('Server error - received HTML response instead of JSON');
      }
      
      const result = await res.json();
      
      if (result.success) {
        // Remove deleted items from DOM
        selectedItems.forEach(id => {
          const item = document.getElementById(`item-${id}`);
          if (item) {
            item.style.transform = "scale(0)";
            item.style.opacity = "0";
            setTimeout(() => item.remove(), 300);
          }
        });
        
        // Clear selection
        selectedItems.clear();
        document.querySelectorAll('.bulk-select').forEach(cb => cb.checked = false);
        updateBulkActionsAfterDelete();
        
        // Show success message
        showNotification(result.message, 'success');
      } else {
        showNotification('Delete failed: ' + result.message, 'error');
      }
    } catch (err) {
      console.error('Bulk delete error:', err);
      showNotification('Delete failed: ' + err.message, 'error');
    }
  });

  // Handle escape key globally when modal is open
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bulkDeleteModal.classList.contains('hidden')) {
      hideBulkDeleteModal();
    }
  });
}

/* ---------- FILE SIZE CALCULATION ---------- */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function updateFileSizeInfo() {
  const fileInput = document.getElementById('fileInput');
  const fileSizeInfo = document.getElementById('fileSizeInfo');
  const fileList = document.getElementById('fileList');
  const totalSize = document.getElementById('totalSize');
  
  if (fileInput.files.length === 0) {
    fileSizeInfo.classList.add('hidden');
    return;
  }
  
  let totalBytes = 0;
  fileList.innerHTML = '';
  
  Array.from(fileInput.files).forEach(file => {
    totalBytes += file.size;
    const fileItem = document.createElement('div');
    fileItem.className = 'flex justify-between items-center';
    fileItem.innerHTML = `
      <span class="truncate mr-2">${file.name}</span>
      <span class="text-blue-400">${formatFileSize(file.size)}</span>
    `;
    fileList.appendChild(fileItem);
  });
  
  totalSize.textContent = formatFileSize(totalBytes);
  fileSizeInfo.classList.remove('hidden');
}

/* ---------- UPLOAD PROGRESS ---------- */
function initUploadProgress() {
  const form = document.getElementById('pasteForm');
  const submitBtn = document.getElementById('submitBtn');
  const submitText = submitBtn.querySelector('.submit-text');
  const submitSpinner = submitBtn.querySelector('.submit-spinner');
  const uploadProgress = document.getElementById('uploadProgress');
  const progressBar = document.getElementById('progressBar');
  const progressPercent = document.getElementById('progressPercent');
  
  // Function to reset the form after successful submission
  function resetFormAfterSuccess() {
    // Reset form fields
    form.reset();
    
    // Hide file size info
    const fileSizeInfo = document.getElementById('fileSizeInfo');
    if (fileSizeInfo) {
      fileSizeInfo.classList.add('hidden');
    }
    
    // Reset upload UI
    resetUploadUI();
  }
  
  form.addEventListener('submit', (e) => {
    const fileInput = document.getElementById('fileInput');
    const hasFiles = fileInput.files.length > 0;
    
    // Show progress for any file upload, not just large files
    if (hasFiles) {
      e.preventDefault();
      
      // Show progress UI
      submitBtn.disabled = true;
      submitText.classList.add('hidden');
      submitSpinner.classList.remove('hidden');
      uploadProgress.classList.remove('hidden');
      
      // Create FormData and submit via XMLHttpRequest for progress tracking
      const formData = new FormData(form);
      const xhr = new XMLHttpRequest();
      
      // Track upload progress
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = progress + '%';
          progressPercent.textContent = progress + '%';
        }
      });
      
      // Handle completion
      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          // Ensure we show 100% briefly before clearing form and reloading
          progressBar.style.width = '100%';
          progressPercent.textContent = '100%';
          
          setTimeout(() => {
            // Reset form before reloading
            resetFormAfterSuccess();
            window.location.reload();
          }, 500);
        } else {
          alert('Upload failed. Please try again.');
          resetUploadUI();
        }
      });
      
      // Handle errors
      xhr.addEventListener('error', () => {
        alert('Upload failed: Network error');
        resetUploadUI();
      });
      
      // Handle abort
      xhr.addEventListener('abort', () => {
        alert('Upload was cancelled');
        resetUploadUI();
      });
      
      // Start the upload
      xhr.open('POST', form.action);
      xhr.send(formData);
    } else {
      // For text-only submissions, we need to handle the form reset differently
      // since the page will reload after submission
      const textArea = document.querySelector('textarea[name="content"]');
      if (textArea && textArea.value.trim()) {
        // Store a flag to reset form after page reload
        sessionStorage.setItem('pasteFormSubmitted', 'true');
      }
    }
  });
  
  function resetUploadUI() {
    submitBtn.disabled = false;
    submitText.classList.remove('hidden');
    submitSpinner.classList.add('hidden');
    uploadProgress.classList.add('hidden');
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
  }

  // Check if we need to reset form after page reload (for text-only submissions)
  if (sessionStorage.getItem('pasteFormSubmitted') === 'true') {
    sessionStorage.removeItem('pasteFormSubmitted');
    // Small delay to ensure DOM is ready
    setTimeout(() => {
      resetFormAfterSuccess();
    }, 100);
  }
}

/* ---------- MODAL ---------- */
function initModal() {
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalContent = document.getElementById('modalContent');
  const modalActions = document.getElementById('modalActions');
  const closeModal = document.getElementById('closeModal');

  closeModal.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal.classList.add('hidden');
  });

  // Helper function to create text preview for title
  function createTextPreview(text, maxLength = 32) {
    if (!text) return 'Empty paste';
    
    // Get first line and trim whitespace
    const firstLine = text.split('\n')[0].trim();
    if (!firstLine) return 'Empty paste';
    
    // Truncate to maxLength and add ellipsis if needed
    if (firstLine.length > maxLength) {
      return firstLine.substring(0, maxLength) + '...';
    }
    return firstLine;
  }

  // Helper function to detect language from text content
  function detectLanguage(text) {
    if (!text) return null;
    
    // Simple language detection based on common patterns
    const firstLine = text.trim().split('\n')[0];
    
    // Check for shebangs
    if (firstLine.startsWith('#!/bin/bash') || firstLine.startsWith('#!/bin/sh')) return 'bash';
    if (firstLine.startsWith('#!/usr/bin/python') || firstLine.startsWith('#!/usr/bin/env python')) return 'python';
    if (firstLine.startsWith('#!/usr/bin/node') || firstLine.startsWith('#!/usr/bin/env node')) return 'javascript';
    
    // Check for common patterns
    if (text.includes('function ') && text.includes('{') && text.includes('}')) return 'javascript';
    if (text.includes('def ') && text.includes(':')) return 'python';
    if (text.includes('class ') && text.includes('{') && text.includes('public')) return 'java';
    if (text.includes('<?php')) return 'php';
    if (text.includes('<html') || text.includes('<!DOCTYPE')) return 'html';
    if (text.includes('body {') || text.includes('.class {')) return 'css';
    if (text.includes('#include') && text.includes('int main')) return 'c';
    if (text.includes('SELECT') && text.includes('FROM')) return 'sql';
    if (text.includes('"scripts":') && text.includes('"dependencies":')) return 'json';
    
    return null; // Let highlight.js auto-detect
  }

  // Helper function to apply syntax highlighting
  function applySyntaxHighlighting() {
    if (typeof hljs !== 'undefined') {
      // Find all code blocks in the modal and apply highlighting
      modal.querySelectorAll('pre code').forEach((block) => {
        // Reset any existing highlighting
        block.removeAttribute('data-highlighted');
        
        // Get the language class or detect it
        let language = null;
        const classNames = block.className.split(' ');
        for (const className of classNames) {
          if (className.startsWith('language-')) {
            language = className.replace('language-', '');
            break;
          }
        }
        
        // If language is 'auto' or not found, try to detect it
        if (!language || language === 'auto') {
          language = detectLanguage(block.textContent);
        }
        
        // Clean up classes
        block.className = block.className.replace(/\bhljs\b/g, '').replace(/\bhljs-[a-z-]+\b/g, '').trim();
        
        // Apply highlighting
        if (language && hljs.getLanguage(language)) {
          // Use specific language if available
          block.className = `language-${language}`;
          const result = hljs.highlight(block.textContent, { language: language });
          block.innerHTML = result.value;
          block.classList.add('hljs');
        } else {
          // Use auto-detection
          block.className = '';
          hljs.highlightElement(block);
        }
      });
    }
  }

  // Card click handlers - use event delegation with specific exclusions
  document.addEventListener('click', async (e) => {
    // Don't trigger modal for these elements
    if (e.target.closest('.bulk-select') || 
        e.target.closest('.copy-btn') || 
        e.target.closest('.delete-btn') || 
        e.target.closest('a[href*="/download/"]') ||
        e.target.closest('.remove-selection') ||
        e.target.closest('#bulkActions')) {
      return;
    }

    const card = e.target.closest('.paste-card');
    if (!card) return;

    const pasteId = card.dataset.pasteId;
    const isFile = card.dataset.isFile === '1';
    const filename = card.dataset.filename;
    const textContent = card.dataset.content;
    const fileSize = card.dataset.fileSize;

    // Clear previous actions
    modalActions.innerHTML = '';

    if (isFile) {
      modalTitle.textContent = filename + (fileSize ? ` (${formatFileSize(parseInt(fileSize))})` : '');
      
      let mediaHtml = '';
      let textHtml = '';
      
      const ext = filename.toLowerCase();
      
      // Generate media content with enhanced preview support
      if (ext.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/)) {
        mediaHtml = `<img src="/file/${pasteId}" class="max-w-full h-auto rounded-lg mb-4" alt="${filename}" loading="lazy">`;
      } else if (ext.match(/\.(mp4|webm|mov|avi|mkv|flv|wmv)$/)) {
        mediaHtml = `<video controls class="max-w-full h-auto rounded-lg mb-4" preload="metadata"><source src="/file/${pasteId}" type="video/mp4">Your browser does not support the video tag.</video>`;
      } else if (ext.match(/\.(mp3|wav|ogg|aac|flac)$/)) {
        mediaHtml = `
          <div class="bg-gray-900 p-6 rounded-lg mb-4 text-center">
            <svg class="w-16 h-16 text-purple-500 mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v6.114A4.369 4.369 0 005 11a4 4 0 104 4V5.82l8-1.6v5.894A4.369 4.369 0 0016 10a4 4 0 104 4V3z"/>
            </svg>
            <audio controls class="w-full">
              <source src="/file/${pasteId}" type="audio/mpeg">
              Your browser does not support the audio element.
            </audio>
          </div>
        `;
      } else if (ext.match(/\.(pdf)$/)) {
        mediaHtml = `
          <div class="bg-gray-900 rounded-lg mb-4 overflow-hidden">
            <iframe src="/file/${pasteId}" class="w-full h-96 border-0"></iframe>
          </div>
        `;
      } else if (ext.match(/\.(txt|md|log|conf|ini|cfg|json|xml|yaml|yml|csv)$/)) {
        try {
          const res = await fetch(`/file/${pasteId}`);
          if (res.ok) {
            const text = await res.text();
            const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            mediaHtml = `
              <div class="bg-gray-900 p-4 rounded-lg mb-4 max-h-96 overflow-auto">
                <pre class="text-sm text-gray-300"><code class="language-${ext.slice(1)}">${escapedText}</code></pre>
              </div>
            `;
          } else {
            mediaHtml = `<div class="text-center py-8 mb-4"><p class="text-red-400">Failed to load file content (file may have been deleted)</p></div>`;
          }
        } catch {
          mediaHtml = `<div class="text-center py-8 mb-4"><p class="text-red-400">Failed to load file content</p></div>`;
        }
      } else if (ext.match(/\.(js|py|html|css|java|cpp|c|php|rb|go|rs|swift)$/)) {
        try {
          const res = await fetch(`/file/${pasteId}`);
          if (res.ok) {
            const text = await res.text();
            const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            mediaHtml = `
              <div class="bg-gray-900 p-4 rounded-lg mb-4 max-h-96 overflow-auto">
                <pre class="text-sm text-gray-300"><code class="language-${getLanguageFromExt(ext)}">${escapedText}</code></pre>
              </div>
            `;
          } else {
            mediaHtml = `<div class="text-center py-8 mb-4"><p class="text-red-400">Failed to load file content (file may have been deleted)</p></div>`;
          }
        } catch {
          mediaHtml = `<div class="text-center py-8 mb-4"><p class="text-red-400">Failed to load file content</p></div>`;
        }
      } else if (ext.match(/\.(doc|docx|xls|xlsx|ppt|pptx)$/)) {
        const officeIcons = {
          'doc': 'text-blue-500', 'docx': 'text-blue-500',
          'xls': 'text-green-500', 'xlsx': 'text-green-500',
          'ppt': 'text-orange-500', 'pptx': 'text-orange-500'
        };
        const fileType = ext.replace('.', '');
        mediaHtml = `
          <div class="bg-gray-900 p-8 rounded-lg mb-4 text-center">
            <svg class="w-20 h-20 ${officeIcons[fileType] || 'text-gray-500'} mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M4 18h12V6l-4-4H4v16zM9 3h6l3 3v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1h6v2z"/>
            </svg>
            <p class="text-lg text-gray-300 mb-2">${filename}</p>
            <p class="text-sm text-gray-400">Office document preview not available</p>
            <p class="text-xs text-gray-500 mt-2">Use download button to open in appropriate application</p>
          </div>
        `;
      } else {
        mediaHtml = `<div class="text-center py-8 mb-4"><p class="text-gray-400">Preview not available for this file type.</p></div>`;
      }
      
      // Generate text content if available (appears AFTER media)
      if (textContent && textContent.trim()) {
        textHtml = `
          <div class="bg-gray-900 p-4 rounded-lg">
            <h4 class="text-sm font-medium text-gray-300 mb-2">Associated Text:</h4>
            <pre class="text-sm text-gray-300 whitespace-pre-wrap">${textContent}</pre>
          </div>
        `;
      }
      
      modalContent.innerHTML = mediaHtml + textHtml;
      
      // Add file actions (include copy if there's text content)
      let actionsHtml = `
        <a href="/download/${pasteId}" class="bg-green-600 hover:bg-green-700 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors">
          Download
        </a>
      `;
      
      if (textContent && textContent.trim()) {
        actionsHtml += `
          <button class="modal-copy-text-btn bg-blue-600 hover:bg-blue-700 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors" data-text="${textContent.replace(/"/g, '&quot;')}">
            Copy Text
          </button>
        `;
      }
      
      actionsHtml += `
        <button class="modal-delete-btn bg-red-600 hover:bg-red-700 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors" data-id="${pasteId}">
          Delete
        </button>
      `;
      
      modalActions.innerHTML = actionsHtml;
    } else {
      // For text pastes, set title to preview of first line instead of "Text Paste"
      let titleText = 'Empty paste';
      let textForModal = '';
      try {
        const res = await fetch(`/raw/${pasteId}`);
        const text = await res.text();
        titleText = createTextPreview(text);
        textForModal = text;
        const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        modalContent.innerHTML = `<pre class="bg-gray-900 p-4 rounded-lg overflow-auto text-sm"><code>${escapedText}</code></pre>`;
      } catch {
        modalContent.innerHTML = '<p class="text-red-400">Failed to load content</p>';
      }
      
      modalTitle.textContent = titleText;
      
      // Add text actions
      modalActions.innerHTML = `
        <button class="modal-copy-btn bg-blue-600 hover:bg-blue-700 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors" data-id="${pasteId}">
          Copy
        </button>
        <button class="modal-delete-btn bg-red-600 hover:bg-red-700 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors" data-id="${pasteId}">
          Delete
        </button>
      `;
    }
    
    // Show modal first
    modal.classList.remove('hidden');
    
    // Apply syntax highlighting with proper timing
    requestAnimationFrame(() => {
      setTimeout(() => {
        applySyntaxHighlighting();
      }, 50);
    });
  });

  // Handle modal actions
  document.addEventListener('click', async (e) => {
    if (e.target.classList.contains('modal-copy-btn')) {
      const id = e.target.dataset.id;
      try {
        const res = await fetch(`/raw/${id}`);
        if (!res.ok) throw new Error("fetch failed");
        const text = await res.text();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select(); document.execCommand("copy");
          document.body.removeChild(ta);
        }
        e.target.textContent = "Copied!";
        setTimeout(() => (e.target.textContent = "Copy"), 1500);
      } catch (err) {
        alert("Copy failed: " + err.message);
      }
    }

    if (e.target.classList.contains('modal-copy-text-btn')) {
      const text = e.target.dataset.text;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement("textarea");
          ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select(); document.execCommand("copy");
          document.body.removeChild(ta);
        }
        e.target.textContent = "Copied!";
        setTimeout(() => (e.target.textContent = "Copy Text"), 1500);
      } catch (err) {
        alert("Copy failed: " + err.message);
      }
    }

    if (e.target.classList.contains('modal-delete-btn')) {
      const id = e.target.dataset.id;
      if (!confirm("Delete this paste?")) return;
      
      try {
        const res = await fetch(`/delete/${id}`, {
          method: "POST",
          headers: { "X-Requested-With": "XMLHttpRequest" }
        });
        if (res.status === 204) {
          modal.classList.add('hidden');
          const item = document.getElementById(`item-${id}`);
          if (item) {
            item.style.transform = "scale(0)";
            item.style.opacity = "0";
            setTimeout(() => {
              item.remove();
              // Remove from selection if it was selected
              if (selectedItems.has(id)) {
                selectedItems.delete(id);
                updateBulkActionsAfterDelete();
              }
            }, 300);
          }
        } else {
          location.reload();
        }
      } catch {
        location.reload();
      }
    }
  });
}

function getLanguageFromExt(ext) {
  const langMap = {
    '.js': 'javascript',
    '.py': 'python',
    '.html': 'html',
    '.css': 'css',
    '.java': 'java',
    '.cpp': 'cpp',
    '.c': 'c',
    '.php': 'php',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.swift': 'swift'
  };
  return langMap[ext] || 'auto';
}

/* ---------- SETTINGS ---------- */
let selectedPath = null;

function initSettings() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsModal = document.getElementById('closeSettingsModal');
  const cancelSettings = document.getElementById('cancelSettings');
  const saveSettings = document.getElementById('saveSettings');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingMessage = document.getElementById('loadingMessage');
  const cleanupBtn = document.getElementById('cleanupBtn');
  
  // Browse functionality
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
  
  let currentBrowsingPath = '';
  let parentPath = null;

  // Open settings modal
  hamburgerBtn.addEventListener('click', async () => {
    settingsModal.classList.remove('hidden');
    await loadSettings();
  });

  // Close settings modal
  [closeSettingsModal, cancelSettings].forEach(btn => {
    btn.addEventListener('click', () => {
      settingsModal.classList.add('hidden');
      selectedPath = null;
      directoryBrowser.classList.add('hidden');
    });
  });

  // Close on backdrop click
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.classList.add('hidden');
      selectedPath = null;
      directoryBrowser.classList.add('hidden');
    }
  });

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
      saveSettings.disabled = false;
    }
  });

  // Save settings
  saveSettings.addEventListener('click', async () => {
    if (!selectedPath) {
      alert('Please select a path first');
      return;
    }
    
    await saveUploadFolder(selectedPath);
  });

  // Manual cleanup button
  if (cleanupBtn) {
    cleanupBtn.addEventListener('click', async () => {
      if (!confirm('This will remove database entries for files that no longer exist in storage. Continue?')) {
        return;
      }
      
      cleanupBtn.disabled = true;
      cleanupBtn.textContent = 'Cleaning...';
      
      try {
        const response = await fetch('/admin/cleanup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        
        const result = await response.json();
        
        if (result.success) {
          alert(result.message);
          // Reload the page to reflect changes
          window.location.reload();
        } else {
          alert('Cleanup failed: ' + result.message);
        }
      } catch (error) {
        console.error('Cleanup error:', error);
        alert('Cleanup failed: ' + error.message);
      } finally {
        cleanupBtn.disabled = false;
        cleanupBtn.textContent = 'Clean Up Orphaned Entries';
      }
    });
  }

  async function loadSettings() {
    try {
      const response = await fetch('/settings');
      const data = await response.json();
      
      document.getElementById('currentPath').textContent = data.current_path;
      selectedPath = data.current_path;
      selectedPathInput.value = data.current_path;
      saveSettings.disabled = true;
      
    } catch (error) {
      console.error('Failed to load settings:', error);
      alert('Failed to load settings. Please try again.');
    }
  }

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
        emptyDiv.className = 'p-6 text-center text-gray-400';
        emptyDiv.textContent = 'This directory contains no subdirectories';
        directoryList.appendChild(emptyDiv);
        return;
      }
      
      data.items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `p-3 border-b border-gray-800 flex items-center justify-between hover:bg-gray-800 cursor-pointer transition-colors ${!item.readable ? 'opacity-50' : ''}`;
        
        const icon = item.type === 'drive' ? '💾' : (item.hidden ? '📁' : '📂');
        const statusText = item.error ? ' (access error)' : '';
        
        // Status indicator and label
        let statusIcon = '';
        let statusLabel = '';
        
        if (item.error) {
          statusIcon = '<span class="text-red-400">⚠</span>';
          statusLabel = 'Error';
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
          <div class="flex items-center gap-3">
            <span class="text-xl">${icon}</span>
            <div>
              <div class="text-sm text-gray-300">${item.name}${statusText}</div>
              <div class="text-xs text-gray-500">${item.type}</div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs ${item.has_subdirs ? 'text-blue-400' : (item.writable ? 'text-green-400' : 'text-gray-500')}">${statusLabel}</span>
            ${statusIcon}
          </div>
        `;
        
        if (item.readable) {
          itemDiv.addEventListener('click', async () => {
            await browseDirectory(item.path);
          });
        }
        
        directoryList.appendChild(itemDiv);
      });
      
    } catch (error) {
      console.error('Failed to browse directory:', error);
      alert('Failed to browse directory: ' + error.message);
    }
  }

  async function saveUploadFolder(newPath) {
    loadingOverlay.classList.remove('hidden');
    loadingMessage.textContent = 'Updating upload folder and migrating files...';
    
    try {
      const response = await fetch('/settings/upload-folder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: newPath })
      });
      
      const result = await response.json();
      
      if (result.success) {
        loadingMessage.textContent = 'Success! Reloading page...';
        
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        throw new Error(result.message);
      }
      
    } catch (error) {
      loadingOverlay.classList.add('hidden');
      console.error('Failed to save settings:', error);
      alert('Failed to update settings: ' + error.message);
    }
  }

  // Close settings on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) {
      if (!directoryBrowser.classList.contains('hidden')) {
        directoryBrowser.classList.add('hidden');
      } else {
        settingsModal.classList.add('hidden');
        selectedPath = null;
      }
    }
  });
}

/* ---------- after DOM loaded ---------- */
function attachItemListeners() {
  document.querySelectorAll(".copy-btn").forEach(handleCopy);
  document.querySelectorAll(".delete-btn").forEach(handleDelete);
}

document.addEventListener("DOMContentLoaded", () => {
  const searchBox = document.getElementById("searchBox");
  const fileInput = document.getElementById('fileInput');

  // File input change listener with enhanced clearing logic
  fileInput.addEventListener('change', (e) => {
    updateFileSizeInfo();
    
    // If no files selected, ensure the display is hidden
    if (e.target.files.length === 0) {
      const fileSizeInfo = document.getElementById('fileSizeInfo');
      if (fileSizeInfo) {
        fileSizeInfo.classList.add('hidden');
      }
    }
  });

  /* enhanced search with date filters */
  window.doSearch = async () => {
    const q = searchBox.value;
    const dateRange = window.getCurrentDateRange ? window.getCurrentDateRange() : { start: '', end: '' };
    
    const params = new URLSearchParams({
      partial: '1',
      q: q,
      start_date: dateRange.start,
      end_date: dateRange.end
    });
    
    const res = await fetch(`/?${params}`);
    if (res.ok) {
      const data = await res.json();
      document.getElementById("pasteList").innerHTML = data.list;
      document.getElementById("pagination").innerHTML = data.pagination;
      
      // Clear selections after search but preserve visual state
      selectedItems.forEach(id => {
        const checkbox = document.querySelector(`.bulk-select[data-id="${id}"]`);
        const card = document.querySelector(`[data-paste-id="${id}"]`);
        if (checkbox && card) {
          checkbox.checked = true;
          card.classList.add('selected');
        }
      });
      
      attachItemListeners();
    }
  };

  // Initialize all features
  initDragDrop();
  initModal();
  initBulkSelection();
  initBulkDeleteModal();
  initDateRangePicker();
  initUploadProgress();
  initSettings();
  initPeriodicFileCheck(); // Add periodic file checking
  attachItemListeners();

  searchBox.addEventListener("input", debounce(doSearch, 1000));
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  stopPeriodicFileCheck();
});
