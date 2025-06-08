import os, sqlite3, mimetypes, platform, shutil
from math import ceil
from datetime import datetime
from flask import (
    Flask, render_template, request, redirect, url_for,
    send_from_directory, abort, jsonify, send_file, flash
)
from werkzeug.utils import secure_filename
import zipfile
import io
import threading
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import logging

APP_ROOT      = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = "/export/nas/paste_bin_files/"
DB_PATH       = os.path.join(APP_ROOT, "pastes.db")
PAGE_SIZE     = 15

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)
app.config.update(
    UPLOAD_FOLDER       = UPLOAD_FOLDER,
    MAX_CONTENT_LENGTH  = None,  # Remove file size limit
    SECRET_KEY          = os.environ.get("PASTEBIN_SECRET", "change-me"),
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global file system watcher
file_watcher = None

# ---------- FILE SYSTEM MONITORING ----------
class PasteFileHandler(FileSystemEventHandler):
    """Handle file system events for paste files"""
    
    def __init__(self):
        super().__init__()
        self.db_path = DB_PATH
        
    def on_deleted(self, event):
        """Handle file deletion events"""
        if event.is_directory:
            return
            
        deleted_file = os.path.basename(event.src_path)
        logger.info(f"File deleted from storage: {deleted_file}")
        
        # Remove corresponding database entry
        self._cleanup_database_entry(deleted_file)
    
    def _cleanup_database_entry(self, filename):
        """Remove database entry for deleted file"""
        try:
            with sqlite3.connect(self.db_path) as db:
                # Find and delete the paste entry
                cursor = db.execute(
                    "SELECT id, original_filename FROM pastes WHERE stored_filename = ? AND is_file = 1",
                    (filename,)
                )
                row = cursor.fetchone()
                
                if row:
                    paste_id, original_filename = row
                    db.execute("DELETE FROM pastes WHERE id = ?", (paste_id,))
                    db.commit()
                    logger.info(f"Deleted database entry for paste {paste_id} (file: {original_filename})")
                else:
                    logger.warning(f"No database entry found for deleted file: {filename}")
                    
        except Exception as e:
            logger.error(f"Error cleaning up database entry for {filename}: {e}")

class FileSystemWatcher:
    """Manages file system monitoring"""
    
    def __init__(self, watch_path):
        self.watch_path = watch_path
        self.observer = None
        self.event_handler = PasteFileHandler()
        self._running = False
        
    def start(self):
        """Start monitoring the file system"""
        if self._running:
            return
            
        try:
            # Ensure watch path exists
            os.makedirs(self.watch_path, exist_ok=True)
            
            self.observer = Observer()
            self.observer.schedule(self.event_handler, self.watch_path, recursive=False)
            self.observer.start()
            self._running = True
            logger.info(f"File system watcher started for: {self.watch_path}")
            
        except Exception as e:
            logger.error(f"Failed to start file system watcher: {e}")
            
    def stop(self):
        """Stop monitoring the file system"""
        if not self._running or not self.observer:
            return
            
        try:
            self.observer.stop()
            self.observer.join(timeout=5)
            self._running = False
            logger.info("File system watcher stopped")
            
        except Exception as e:
            logger.error(f"Error stopping file system watcher: {e}")
            
    def restart(self, new_path):
        """Restart watcher with new path"""
        self.stop()
        self.watch_path = new_path
        self.start()

def init_file_watcher():
    """Initialize file system monitoring"""
    global file_watcher
    current_path = get_current_upload_folder()
    file_watcher = FileSystemWatcher(current_path)
    file_watcher.start()

def cleanup_orphaned_entries():
    """Clean up database entries for files that no longer exist"""
    current_path = get_current_upload_folder()
    cleanup_count = 0
    
    try:
        with get_db() as db:
            # Get all file entries
            file_entries = db.execute(
                "SELECT id, stored_filename, original_filename FROM pastes WHERE is_file = 1"
            ).fetchall()
            
            for entry in file_entries:
                paste_id, stored_filename, original_filename = entry
                file_path = os.path.join(current_path, stored_filename)
                
                if not os.path.exists(file_path):
                    # File doesn't exist, remove database entry
                    db.execute("DELETE FROM pastes WHERE id = ?", (paste_id,))
                    cleanup_count += 1
                    logger.info(f"Cleaned up orphaned entry: {paste_id} ({original_filename})")
            
            if cleanup_count > 0:
                db.commit()
                logger.info(f"Cleaned up {cleanup_count} orphaned database entries")
                
    except Exception as e:
        logger.error(f"Error during orphaned entries cleanup: {e}")
        
    return cleanup_count

# ---------- DB ----------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS pastes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT,
                stored_filename TEXT,
                original_filename TEXT,
                is_file INTEGER,
                file_size INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        # Create settings table for storing app configuration
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        # Add file_size column if it doesn't exist (for existing databases)
        try:
            db.execute("ALTER TABLE pastes ADD COLUMN file_size INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # Column already exists
        
        # Initialize upload folder setting if it doesn't exist
        current_path = db.execute("SELECT value FROM settings WHERE key=?", ("upload_folder",)).fetchone()
        if not current_path:
            db.execute("INSERT INTO settings (key, value) VALUES (?, ?)", ("upload_folder", UPLOAD_FOLDER))
            db.commit()
init_db()

def format_file_size(size_bytes):
    """Convert bytes to human readable format"""
    if size_bytes == 0:
        return "0 B"
    size_names = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    while size_bytes >= 1024 and i < len(size_names) - 1:
        size_bytes /= 1024.0
        i += 1
    return f"{size_bytes:.1f} {size_names[i]}"

# ---------- Filters ----------
@app.template_filter("snippet")
def snippet_filter(value, length: int = 20):
    value = (value or "").replace("\n", " ")
    return (value[:length] + "...") if len(value) > length else value

@app.template_filter("is_image")
def is_image_filter(filename):
    mtype, _ = mimetypes.guess_type(filename or "")
    return bool(mtype and mtype.startswith("image/"))

@app.template_filter("format_size")
def format_size_filter(size_bytes):
    return format_file_size(size_bytes or 0)

# ---------- Settings Management ----------
def get_current_upload_folder():
    """Get the current upload folder from database"""
    with get_db() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", ("upload_folder",)).fetchone()
        return row["value"] if row else UPLOAD_FOLDER

def update_upload_folder(new_path):
    """Update the upload folder setting in database"""
    global file_watcher
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ("upload_folder", new_path))
        db.commit()
    
    # Restart file watcher with new path
    if file_watcher:
        file_watcher.restart(new_path)

def is_first_time_setup():
    """Check if this is the first time the app is being accessed"""
    with get_db() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", ("setup_complete",)).fetchone()
        return row is None

def complete_setup():
    """Mark setup as complete"""
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ("setup_complete", "true"))
        db.commit()

def migrate_files(old_path, new_path):
    """Migrate files from old path to new path"""
    if not os.path.exists(old_path):
        return {"success": True, "message": "No files to migrate (old path doesn't exist)"}
    
    if not os.path.exists(new_path):
        try:
            os.makedirs(new_path, exist_ok=True)
        except Exception as e:
            return {"success": False, "message": f"Failed to create new directory: {str(e)}"}
    
    if not os.access(new_path, os.W_OK):
        return {"success": False, "message": "New path is not writable"}
    
    moved_count = 0
    error_count = 0
    errors = []
    
    try:
        for filename in os.listdir(old_path):
            old_file = os.path.join(old_path, filename)
            new_file = os.path.join(new_path, filename)
            
            if os.path.isfile(old_file):
                try:
                    shutil.move(old_file, new_file)
                    moved_count += 1
                except Exception as e:
                    error_count += 1
                    errors.append(f"Failed to move {filename}: {str(e)}")
    except Exception as e:
        return {"success": False, "message": f"Failed to list files in old directory: {str(e)}"}
    
    message = f"Migration completed. Moved {moved_count} files."
    if error_count > 0:
        message += f" {error_count} files failed to move."
    
    return {
        "success": True,
        "message": message,
        "moved_count": moved_count,
        "error_count": error_count,
        "errors": errors
    }

# ---------- Routes ----------
@app.route("/", methods=["GET"])
def index():
    # Check if this is first time setup
    if is_first_time_setup():
        return render_template("welcome.html")
    
    # Regular index logic
    page = max(int(request.args.get("page", 1)), 1)
    q    = request.args.get("q", "").strip()
    start_date = request.args.get("start_date", "").strip()
    end_date = request.args.get("end_date", "").strip()

    where, params = "", []
    conditions = []
    
    if q:
        conditions.append("(content LIKE ? OR original_filename LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like])
    
    if start_date:
        conditions.append("DATE(created_at) >= ?")
        params.append(start_date)
    
    if end_date:
        conditions.append("DATE(created_at) <= ?")
        params.append(end_date)
    
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    offset = (page - 1) * PAGE_SIZE
    with get_db() as db:
        total  = db.execute(f"SELECT COUNT(*) FROM pastes {where}", params).fetchone()[0]
        pastes = db.execute(
            f"""SELECT * FROM pastes
                {where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?""",
            params + [PAGE_SIZE, offset],
        ).fetchall()

    last_page = max(ceil(total / PAGE_SIZE), 1)

    # ---------- AJAX (partial) ----------
    if request.args.get("partial") == "1":
        return jsonify(
            list=render_template("_pastes.html", pastes=pastes),
            pagination=render_template(
                "_pagination.html", page=page, last_page=last_page, q=q
            ),
        )

    return render_template(
        "index.html",
        pastes=pastes,
        page=page,
        last_page=last_page,
        q=q,
    )

@app.route("/paste", methods=["POST"])
def paste():
    text = request.form.get("content", "").strip()
    files = request.files.getlist("files")
    
    current_upload_folder = get_current_upload_folder()
    os.makedirs(current_upload_folder, exist_ok=True)

    with get_db() as db:
        # Handle multiple file uploads
        if files and any(f.filename for f in files):
            for upload in files:
                if upload and upload.filename:
                    original = secure_filename(upload.filename)
                    ts = datetime.now().strftime("%Y%m%d%H%M%S%f")
                    stored = f"{ts}_{original}"
                    file_path = os.path.join(current_upload_folder, stored)
                    upload.save(file_path)
                    
                    # Get file size
                    file_size = os.path.getsize(file_path)
                    
                    # Store with optional text content and file size
                    db.execute(
                        "INSERT INTO pastes (content, stored_filename, original_filename, is_file, file_size)"
                        " VALUES (?,?,?,1,?)",
                        (text if text else None, stored, original, file_size),
                    )
        elif text:
            # Text-only paste
            db.execute(
                "INSERT INTO pastes (content, is_file, file_size) VALUES (?,0,?)",
                (text, len(text.encode('utf-8'))),
            )
    
    return redirect(url_for("index"))

@app.route("/admin/cleanup", methods=["POST"])
def manual_cleanup():
    """Manual cleanup of orphaned database entries"""
    try:
        cleanup_count = cleanup_orphaned_entries()
        return jsonify({
            "success": True,
            "message": f"Cleanup completed. Removed {cleanup_count} orphaned entries.",
            "cleanup_count": cleanup_count
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "message": f"Cleanup failed: {str(e)}"
        }), 500

@app.route("/admin/check-files", methods=["POST"])
def check_files():
    """Periodic check for missing files"""
    try:
        cleanup_count = cleanup_orphaned_entries()
        return jsonify({
            "success": True,
            "cleanup_count": cleanup_count,
            "message": f"Found {cleanup_count} missing files" if cleanup_count > 0 else "All files present"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "message": f"Check failed: {str(e)}"
        }), 500

@app.route("/file/<int:paste_id>")
def file_inline(paste_id):
    with get_db() as db:
        row = db.execute(
            "SELECT stored_filename, original_filename"
            " FROM pastes WHERE id=? AND is_file=1",
            (paste_id,),
        ).fetchone()
    if not row:
        abort(404)
    
    # Use current upload folder instead of config
    current_upload_folder = get_current_upload_folder()
    file_path = os.path.join(current_upload_folder, row["stored_filename"])
    
    # Check if file exists
    if not os.path.exists(file_path):
        abort(404)
    
    mtype, _ = mimetypes.guess_type(row["original_filename"])
    return send_from_directory(
        current_upload_folder,
        row["stored_filename"],
        mimetype=mtype or "application/octet-stream",
        as_attachment=False,
        download_name=row["original_filename"],
    )

@app.route("/download/<int:paste_id>")
def download(paste_id):
    with get_db() as db:
        row = db.execute(
            "SELECT stored_filename, original_filename"
            " FROM pastes WHERE id=? AND is_file=1",
            (paste_id,),
        ).fetchone()
    if not row:
        abort(404)
    
    # Use current upload folder instead of config
    current_upload_folder = get_current_upload_folder()
    file_path = os.path.join(current_upload_folder, row["stored_filename"])
    
    # Check if file exists
    if not os.path.exists(file_path):
        abort(404)
    
    return send_from_directory(
        current_upload_folder,
        row["stored_filename"],
        as_attachment=True,
        download_name=row["original_filename"],
    )

@app.route("/delete/<int:paste_id>", methods=["POST"])
def delete_paste(paste_id):
    current_upload_folder = get_current_upload_folder()
    
    with get_db() as db:
        row = db.execute(
            "SELECT stored_filename, is_file FROM pastes WHERE id=?", (paste_id,)
        ).fetchone()
        if not row:
            abort(404)
        if row["is_file"]:
            try:
                file_path = os.path.join(current_upload_folder, row["stored_filename"])
                if os.path.exists(file_path):
                    os.remove(file_path)
            except FileNotFoundError:
                pass
        db.execute("DELETE FROM pastes WHERE id=?", (paste_id,))

    # 204 = No Content → JS removes list item.
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return ("", 204)
    return redirect(url_for("index"))

@app.route("/bulk-download", methods=["POST"])
def bulk_download():
    paste_ids = request.json.get("ids", [])
    if not paste_ids:
        abort(400)
    
    current_upload_folder = get_current_upload_folder()
    zip_buffer = io.BytesIO()
    
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        with get_db() as db:
            for paste_id in paste_ids:
                row = db.execute(
                    "SELECT content, stored_filename, original_filename, is_file"
                    " FROM pastes WHERE id=?",
                    (paste_id,)
                ).fetchone()
                
                if not row:
                    continue
                    
                if row["is_file"]:
                    file_path = os.path.join(current_upload_folder, row["stored_filename"])
                    if os.path.exists(file_path):
                        zip_file.write(file_path, row["original_filename"])
                else:
                    zip_file.writestr(f"paste_{paste_id}.txt", row["content"])
    
    zip_buffer.seek(0)
    filename = f"pastebin_bulk_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    
    response = send_file(
        zip_buffer,
        as_attachment=True,
        download_name=filename,
        mimetype="application/zip"
    )
    response.headers['Content-Disposition'] = f'attachment; filename="{filename}"'
    return response

@app.route("/bulk-delete", methods=["POST"])
def bulk_delete():
    paste_ids = request.json.get("ids", [])
    if not paste_ids:
        return jsonify(success=False, message="No IDs provided"), 400
    
    deleted_count = 0
    errors = []
    
    current_upload_folder = get_current_upload_folder()

    try:
        with get_db() as db:
            for paste_id_str in paste_ids:
                try:
                    paste_id = int(paste_id_str) # Ensure it's an integer
                    row = db.execute(
                        "SELECT stored_filename, is_file FROM pastes WHERE id=?", (paste_id,)
                    ).fetchone()
                    
                    if not row:
                        errors.append(f"Paste ID {paste_id} not found.")
                        continue

                    if row["is_file"] and row["stored_filename"]:
                        try:
                            file_path = os.path.join(current_upload_folder, row["stored_filename"])
                            if os.path.exists(file_path):
                                os.remove(file_path)
                        except OSError as e:
                            logger.error(f"Error deleting file {row['stored_filename']} for paste {paste_id}: {e}")
                            errors.append(f"Error deleting file for paste ID {paste_id}.")
                    
                    db.execute("DELETE FROM pastes WHERE id=?", (paste_id,))
                    deleted_count += 1
                except ValueError:
                    errors.append(f"Invalid Paste ID format: {paste_id_str}")
                except Exception as e:
                    logger.error(f"Error deleting paste {paste_id_str}: {e}")
                    errors.append(f"Error processing paste ID {paste_id_str}.")
            
            db.commit()

        if deleted_count > 0:
            message = f"Successfully deleted {deleted_count} items."
            if errors:
                message += f" {len(errors)} items had errors."
            return jsonify(success=True, message=message, deleted_count=deleted_count, errors=errors)
        else:
            return jsonify(success=False, message="No items were deleted.", errors=errors), 400
            
    except Exception as e:
        logger.error(f"Bulk delete error: {e}")
        return jsonify(success=False, message=f"Database error: {str(e)}"), 500

# ---------- Settings ----------
@app.route("/settings", methods=["GET"])
def settings():
    """Get current settings"""
    current_path = get_current_upload_folder()
    
    return jsonify({
        "current_path": current_path,
        "is_first_time": is_first_time_setup()
    })

@app.route("/settings/browse", methods=["POST"])
def browse_directory():
    """Browse directory structure with full filesystem access"""
    data = request.get_json()
    path = data.get("path", "").strip()
    
    # If no path provided, start from appropriate root based on OS
    if not path:
        system = platform.system().lower()
        if system == "windows":
            # List available drives on Windows
            drives = []
            for drive_letter in ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']:
                drive_path = f"{drive_letter}:\\"
                if os.path.exists(drive_path):
                    try:
                        # Check if we can access the drive
                        readable = os.access(drive_path, os.R_OK)
                        writable = os.access(drive_path, os.W_OK)
                        drives.append({
                            "name": f"{drive_letter}: Drive",
                            "path": drive_path,
                            "type": "drive",
                            "writable": writable,
                            "readable": readable,
                            "hidden": False,
                            "has_subdirs": True,
                            "error": False
                        })
                    except (PermissionError, OSError):
                        # Add drive even if we can't check permissions
                        drives.append({
                            "name": f"{drive_letter}: Drive (Limited Access)",
                            "path": drive_path,
                            "type": "drive",
                            "writable": False,
                            "readable": False,
                            "hidden": False,
                            "has_subdirs": True,
                            "error": True
                        })
            
            return jsonify({
                "success": True,
                "items": drives,
                "current_path": "",
                "parent_path": None,
                "current_writable": False
            })
        else:
            path = "/"
    
    # Validate path exists
    if not os.path.exists(path):
        return jsonify({"success": False, "message": f"Path '{path}' does not exist"}), 400
    
    try:
        items = []
        
        # Add parent directory option (except for root)
        parent_path = None
        if path != "/" and not (platform.system().lower() == "windows" and (len(path) <= 3 or path == "")):
            parent_path = os.path.dirname(path.rstrip(os.sep))
            if platform.system().lower() == "windows":
                # Handle Windows-specific parent path logic
                if len(parent_path) <= 3 and parent_path.endswith(":"):
                    parent_path = ""  # Go back to drives list
                elif parent_path == path.rstrip("\\"):
                    parent_path = ""  # Go back to drives list
        
        # List directories only (for cleaner interface)
        try:
            all_items = []
            
            for item in os.listdir(path):
                item_path = os.path.join(path, item)
                try:
                    if os.path.isdir(item_path):
                        is_hidden = item.startswith('.')
                        writable = os.access(item_path, os.W_OK)
                        readable = os.access(item_path, os.R_OK)
                        
                        # Check if this directory has subdirectories
                        has_subdirs = False
                        if readable:
                            try:
                                for subitem in os.listdir(item_path):
                                    subitem_path = os.path.join(item_path, subitem)
                                    if os.path.isdir(subitem_path):
                                        has_subdirs = True
                                        break
                            except (PermissionError, OSError):
                                # If we can't read the directory, assume it might have subdirs
                                has_subdirs = True
                        
                        all_items.append({
                            "name": item,
                            "path": item_path,
                            "type": "directory",
                            "writable": writable,
                            "readable": readable,
                            "hidden": is_hidden,
                            "has_subdirs": has_subdirs,
                            "error": False
                        })
                        
                except (PermissionError, OSError):
                    # Add directory even if we can't check permissions
                    all_items.append({
                        "name": item,
                        "path": item_path,
                        "type": "directory",
                        "writable": False,
                        "readable": False,
                        "hidden": item.startswith('.'),
                        "error": True,
                        "has_subdirs": False  # Can't determine, assume no subdirs
                    })
            
            # Sort items: non-hidden directories first, then by name
            all_items.sort(key=lambda x: (x["hidden"], x["name"].lower()))
            items = all_items
            
        except PermissionError:
            return jsonify({
                "success": False, 
                "message": "Permission denied to access this directory"
            }), 403
        
        return jsonify({
            "success": True,
            "items": items,
            "current_path": path,
            "parent_path": parent_path,
            "current_writable": os.access(path, os.W_OK)
        })
        
    except Exception as e:
        return jsonify({"success": False, "message": f"Error browsing directory: {str(e)}"}), 500

@app.route("/settings/upload-folder", methods=["POST"])
def update_upload_folder_route():
    """Update the upload folder path"""
    data = request.get_json()
    new_path = data.get("path", "").strip()
    is_setup = data.get("is_setup", False)
    
    if not new_path:
        return jsonify({"success": False, "message": "Path is required"}), 400
    
    # Create directory if it doesn't exist
    if not os.path.exists(new_path):
        try:
            os.makedirs(new_path, exist_ok=True)
        except Exception as e:
            return jsonify({"success": False, "message": f"Failed to create directory: {str(e)}"}), 500
    
    # Check if writable
    if not os.access(new_path, os.W_OK):
        return jsonify({"success": False, "message": "Directory is not writable"}), 400
    
    current_path = get_current_upload_folder()
    
    # If path is different, migrate files (only if not setup)
    migration_result = {"success": True, "message": "No files to migrate"}
    if not is_setup and current_path != new_path and os.path.exists(current_path):
        migration_result = migrate_files(current_path, new_path)
        if not migration_result["success"]:
            return jsonify(migration_result), 500
    
    # Update the path in database (this will also restart the file watcher)
    update_upload_folder(new_path)
    
    # Update the app config
    app.config['UPLOAD_FOLDER'] = new_path
    
    # Clean up any orphaned entries after path change
    cleanup_count = cleanup_orphaned_entries()
    
    # Mark setup as complete if this is initial setup
    if is_setup:
        complete_setup()
    
    message = f"Upload folder updated successfully. {migration_result['message']}"
    if cleanup_count > 0:
        message += f" Cleaned up {cleanup_count} orphaned entries."
    
    return jsonify({
        "success": True,
        "message": message,
        "migration_details": migration_result,
        "cleanup_count": cleanup_count
    })

# Initialize services when app context is created
def init_app_services():
    """Initialize services that need to run once"""
    if not hasattr(app, '_services_initialized'):
        init_file_watcher()
        # Perform initial cleanup
        cleanup_count = cleanup_orphaned_entries()
        if cleanup_count > 0:
            logger.info(f"Startup cleanup: removed {cleanup_count} orphaned entries")
        app._services_initialized = True

# Use app context to initialize services
with app.app_context():
    init_app_services()

# Cleanup on app shutdown
import atexit

def shutdown_handler():
    """Clean shutdown of file watcher"""
    global file_watcher
    if file_watcher:
        file_watcher.stop()

atexit.register(shutdown_handler)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
