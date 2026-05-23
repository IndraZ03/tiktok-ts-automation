"""
TikTok Multi-Upload Scheduler - Modern Tkinter GUI
Automates scheduled uploading of multiple videos to TikTok.
References upload.py for core Selenium automation logic.
"""
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import threading
import json
import os
import sys
import time
import subprocess
import random
import winsound
from datetime import datetime, timedelta

# ── Selenium imports ──
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains

# ═══════════════════════════════════════════════════════════════
# CONSTANTS & COLORS
# ═══════════════════════════════════════════════════════════════
BG           = "#0f0f1a"
BG_CARD      = "#1a1a2e"
BG_INPUT     = "#16213e"
FG           = "#e0e0ff"
FG_DIM       = "#8888aa"
ACCENT       = "#00d2ff"
ACCENT2      = "#7b2ff7"
SUCCESS      = "#00e676"
ERROR        = "#ff5252"
WARN         = "#ffc107"
BORDER       = "#2a2a4a"
BTN_BG       = "#7b2ff7"
BTN_FG       = "#ffffff"
BTN_HOVER    = "#9d5cff"
BTN_DANGER   = "#ff5252"

DB_FILE = "upload_history.json"


# ═══════════════════════════════════════════════════════════════
# DATABASE  (JSON)
# ═══════════════════════════════════════════════════════════════
def load_db():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_db(db):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)

def get_uploaded_videos(folder_name, db):
    return db.get(folder_name, [])

def mark_uploaded(folder_name, video_name, db):
    if folder_name not in db:
        db[folder_name] = []
    if video_name not in db[folder_name]:
        db[folder_name].append(video_name)
    save_db(db)


# ═══════════════════════════════════════════════════════════════
# PATHS
# ═══════════════════════════════════════════════════════════════
TIKTOK_JS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tiktok_auto.js")

# ═══════════════════════════════════════════════════════════════
# CORE AUTOMATION (JS injection approach)
# ═══════════════════════════════════════════════════════════════
def inject_tiktok_js(driver):
    """Inject tiktok_auto.js into the current page."""
    with open(TIKTOK_JS_FILE, 'r', encoding='utf-8') as f:
        js_code = f.read()
    driver.execute_script(js_code)

def kill_chrome_on_port(port):
    """Kill any Chrome process using the specified debug port."""
    try:
        result = subprocess.run(
            ['netstat', '-ano'], capture_output=True, text=True, timeout=10)
        for line in result.stdout.splitlines():
            if f':{port}' in line and 'LISTENING' in line:
                parts = line.strip().split()
                pid = parts[-1]
                if pid.isdigit():
                    subprocess.run(['taskkill', '/PID', pid, '/F', '/T'],
                                   capture_output=True, timeout=10)
    except:
        pass
    time.sleep(2)

def open_chrome_debug(user_data_dir, port):
    # Kill zombie Chrome from previous session
    kill_chrome_on_port(port)
    # Remove orphan chrome.exe inside user_data to prevent version mismatch crash
    orphan_chrome = os.path.join(user_data_dir, "chrome.exe")
    if os.path.exists(orphan_chrome):
        try:
            os.remove(orphan_chrome)
        except Exception:
            pass

    chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    cmd = [
        chrome_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-infobars",
        "--disable-features=InfiniteSessionRestore",
        "https://www.tiktok.com/tiktokstudio/upload",
    ]
    proc = subprocess.Popen(cmd)
    time.sleep(7)
    return proc

def connect_selenium(port):
    opts = Options()
    opts.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
    svc = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=svc, options=opts)

    # Dismiss any "Restore pages" dialog
    time.sleep(2)
    try:
        # Chrome restore bar has a button with text containing 'Restore'
        restore_btns = driver.find_elements(By.XPATH,
            "//button[contains(text(),'Restore') or contains(text(),'restore')]")
        if restore_btns:
            restore_btns[0].click()
            time.sleep(2)
    except:
        pass

    # Verify we're on an actual page, not about:blank or chrome error
    try:
        current = driver.current_url
        if not current or current in ('about:blank', 'chrome://newtab/', 'data:,'):
            driver.get("https://www.tiktok.com/tiktokstudio/upload")
            time.sleep(5)
    except:
        driver.get("https://www.tiktok.com/tiktokstudio/upload")
        time.sleep(5)

    return driver

def navigate_upload_page(driver, force=False):
    """Always force a fresh upload page to avoid leftover state from previous uploads."""
    if force:
        # Gunakan tab baru untuk menghindari HTTP 403 pada upload kedua dan seterusnya 
        # karena state tab lama bisa saja stale di mata TikTok.
        driver.execute_script("window.open('https://www.tiktok.com/tiktokstudio/upload', '_blank');")
        time.sleep(2)
        
        # Tutup semua tab selain tab yang baru saja dibuka
        windows = driver.window_handles
        new_window = windows[-1]
        for w in windows[:-1]:
            driver.switch_to.window(w)
            driver.close()
            
        # Pindah fokus ke tab yang baru
        driver.switch_to.window(new_window)
        time.sleep(3)
    elif "tiktok.com/tiktokstudio/upload" not in driver.current_url:
        driver.get("https://www.tiktok.com/tiktokstudio/upload")
        time.sleep(3)

    # Verify we see the upload input (page fully loaded)
    try:
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//input[@type='file']")))
    except:
        # Retry once
        driver.refresh()
        time.sleep(5)

def inject_video_file(driver, file_path):
    wait = WebDriverWait(driver, 30)
    upload_script = """
        let ipts = document.querySelectorAll('input[type="file"]');
        for(let i=0; i<ipts.length; i++) {
            if(ipts[i].accept && ipts[i].accept.includes('video')) return ipts[i];
        }
        let btn = document.querySelector('button[data-e2e="select_video_button"]') || document.querySelector('button[aria-label="Select video"]');
        if (btn) {
            let p = btn.parentElement;
            for(let i=0; i<5 && p; i++) {
                let f = p.querySelector('input[type="file"]');
                if (f) return f;
                p = p.parentElement;
            }
        }
        return ipts.length ? ipts[ipts.length - 1] : null;
    """
    upload_input = wait.until(lambda d: d.execute_script(upload_script))
    if not upload_input:
        raise Exception("Elemen input upload video tidak ditemukan!")
    upload_input.send_keys(os.path.abspath(os.path.normpath(file_path)))

def do_upload_file(driver, file_path, log):
    log("Mencari elemen upload...")
    try:
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        wait = WebDriverWait(driver, 30)
        wait.until(EC.presence_of_element_located((By.XPATH, "//button[@data-e2e='select_video_button' or @aria-label='Select video']")))
        log("✓ Tombol upload siap di web")
    except Exception as e:
        log("⚠️ Menunggu tombol upload lama, mungkin belum siap...")
    
    inject_video_file(driver, file_path)
    log(f"✓ File disuntikkan: {os.path.basename(file_path)}")
    time.sleep(5)

def do_post_video(driver, deskripsi, nama_produk_radio, nama_produk_input, log,
                  schedule_dt, stop_event, add_sound=False, add_product=True,
                  skip_switches=False, hashtags=None, location=None):
    """
    Full posting flow: description, product, switches, sounds, schedule.
    schedule_dt: datetime object for when to schedule.
    """
    wait = WebDriverWait(driver, 20)

    def safe(fn, msg=""):
        try:
            fn()
        except Exception as e:
            log(f"⚠ {msg}: {e}")

    # ── Turn on ──
    try:
        turn_on = WebDriverWait(driver, 5).until(EC.element_to_be_clickable(
            (By.XPATH, "//div[contains(@class, 'Button__content') and text()='Turn on']")))
        turn_on.click(); time.sleep(2)
    except:
        pass

    # ── Description ──
    log("Mengisi deskripsi...")
    caption = wait.until(EC.presence_of_element_located(
        (By.XPATH, "//div[@role='textbox'] | //div[contains(@class, 'notranslate public-DraftEditor-content')]")))
    caption.click()
    caption.send_keys(Keys.CONTROL + "a"); caption.send_keys(Keys.BACKSPACE)
    caption.send_keys(deskripsi); time.sleep(1)

    # ── Hashtags (typed char-by-char + Tab to confirm autocomplete) ──
    if hashtags:
        log(f"Menambahkan {len(hashtags)} hashtag...")
        for tag in hashtags:
            tag = tag.strip().lstrip('#')
            if not tag:
                continue
            log(f"  Mengetik #{tag}...")
            caption.send_keys(' ')
            time.sleep(0.3)
            caption.send_keys('#')
            time.sleep(0.5)
            for ch in tag:
                caption.send_keys(ch)
                time.sleep(0.15)
            time.sleep(1.5)
            caption.send_keys(Keys.TAB)
            time.sleep(1)
            log(f"  ✓ #{tag} ditambahkan")
        log("✓ Semua hashtag ditambahkan")
        time.sleep(1)

    # ── Location ──
    if location:
        log(f"📍 Mengisi lokasi: {location}...")
        try:
            # Cari input lokasi
            loc_input = WebDriverWait(driver, 10).until(EC.presence_of_element_located(
                (By.XPATH, "//input[@placeholder='Search locations' and @role='input']")))
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", loc_input)
            time.sleep(1)
            loc_input.click()
            time.sleep(0.5)
            # Clear dan ketik lokasi
            loc_input.send_keys(Keys.CONTROL + "a")
            loc_input.send_keys(Keys.BACKSPACE)
            time.sleep(0.3)
            for ch in location:
                loc_input.send_keys(ch)
                time.sleep(0.08)
            log(f"  Menunggu dropdown lokasi muncul...")
            time.sleep(3)
            # Klik opsi pertama di dropdown lokasi
            try:
                first_option = WebDriverWait(driver, 10).until(EC.element_to_be_clickable(
                    (By.XPATH, "//div[@role='option'][1]")))
                first_option.click()
                log(f"✓ Lokasi dipilih: {location}", )
            except:
                # Fallback: cari option dengan class Select__item
                try:
                    first_opt2 = WebDriverWait(driver, 5).until(EC.element_to_be_clickable(
                        (By.XPATH, "//div[contains(@class,'Select__item')][1]")))
                    first_opt2.click()
                    log(f"✓ Lokasi dipilih (fallback): {location}")
                except Exception as e_loc2:
                    log(f"⚠ Gagal memilih lokasi dari dropdown: {e_loc2}")
            time.sleep(1)
        except Exception as e_loc:
            log(f"⚠ Gagal mengisi lokasi: {e_loc}")
    else:
        log("⏭ Lokasi dilewati (tidak diaktifkan)")

    # ── Add product ──
    if not add_product:
        log("⏭ Produk dilewati (tidak diaktifkan)")
    else:
      log("Menambahkan produk...")
    # A – click + Add
      add_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[.//div[text()='Add']]")))
      add_btn.click(); time.sleep(2)
      # B – Next 1
      n1 = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[.//div[text()='Next']]")))
      n1.click(); time.sleep(2)

      # B2 – Cek apakah ada tab "My shop", jika ya klik "Showcase products"
      try:
          my_shop_tab = driver.find_elements(By.XPATH,
              "//div[contains(@class,'TUXTabBar-item')]//button[contains(@class,'TUXTabBar-itemTitle')]//div[text()='My shop']")
          if my_shop_tab and my_shop_tab[0].is_displayed():
              log("Tab 'My shop' terdeteksi, klik 'Showcase products'...")
              showcase_tab = WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.XPATH,
                  "//div[contains(@class,'TUXTabBar-item')]//button[contains(@class,'TUXTabBar-itemTitle')]//div[text()='Showcase products']")))
              showcase_tab.click()
              time.sleep(2)
              log("✓ Tab 'Showcase products' diklik")
          else:
              log("Tab 'My shop' tidak terdeteksi, lanjut...")
      except Exception as e_tab:
          log(f"⚠ Cek tab My shop: {e_tab}")

      # C – Search product then select radio button
      log(f"STEP C: Mencari produk: {nama_produk_radio[:60]}...")
      
      # C1 – Cari input search products & ketik nama produk
      try:
          search_input = WebDriverWait(driver, 10).until(
              EC.presence_of_element_located((By.XPATH, "//input[@placeholder='Search products']")))
          search_input.clear()
          search_input.send_keys(nama_produk_radio)
          time.sleep(1)
          log(f"✓ Ketik '{nama_produk_radio[:40]}' di search")
          
          # C2 – Klik tombol search (icon svg)
          try:
              search_icon = driver.find_element(By.XPATH,
                  "//div[contains(@class,'product-search-icon')]")
              search_icon.click()
              log("✓ Klik search icon")
          except:
              # Fallback: tekan Enter
              search_input.send_keys(Keys.ENTER)
              log("✓ Tekan Enter untuk search")
          time.sleep(3)
      except Exception as e_search:
          log(f"⚠ Search input tidak ada, langsung pilih radio: {e_search}")

      # C3 – Pilih radio button
      log(f"STEP C3: Memilih radio: {nama_produk_radio[:60]}...")
      xpath_produk = f"//input[@type='radio' and @name='{nama_produk_radio}']"
      radio = wait.until(EC.presence_of_element_located((By.XPATH, xpath_produk)))
      target_radio_wrapper = radio.find_element(By.XPATH, "./..")
      driver.execute_script("arguments[0].scrollIntoView({block:'center'});", target_radio_wrapper)
      time.sleep(1)
      try:
          target_radio_wrapper.click()
          log("Klik wrapper produk (standar)")
      except:
          driver.execute_script("arguments[0].click();", target_radio_wrapper)
          log("Klik wrapper produk (JS)")
      time.sleep(1)
      log("✓ Radio button produk dipilih")

      # D – Next 2 (Full logic from upload.py with verification & fallbacks)
      log("STEP D: Mencoba klik Next tombol kedua...")
      time.sleep(2)
      
      next_buttons = driver.find_elements(By.XPATH, "//button[.//div[text()='Next']]")
      log(f"Ditemukan {len(next_buttons)} tombol Next")
      
      target_next = None
      for i, btn in enumerate(next_buttons):
          is_vis = btn.is_displayed()
          is_en = btn.is_enabled()
          cls = btn.get_attribute("class") or ""
          aria_dis = btn.get_attribute("aria-disabled")
          log(f"  Tombol {i+1}: Visible={is_vis}, Enabled={is_en}, Class={cls[:80]}, aria-disabled={aria_dis}")
          
          if is_vis and "primary" in cls:
              target_next = btn
              log(f"  -> TERPILIH sebagai target")
      
      if target_next:
          log("Tombol target ditemukan, mencoba klik...")
          driver.execute_script("arguments[0].scrollIntoView({block:'center', behavior:'smooth'});", target_next)
          time.sleep(1)
          
          # Method 1: ActionChains
          try:
              actions = ActionChains(driver)
              actions.move_to_element(target_next).click().perform()
              log("Klik dengan ActionChains berhasil")
          except Exception as e_ac:
              log(f"ActionChains gagal: {e_ac}")
              # Method 2: Regular click
              try:
                  target_next.click()
                  log("Klik biasa berhasil")
              except:
                  # Method 3: JavaScript
                  driver.execute_script("arguments[0].click();", target_next)
                  log("Klik JavaScript berhasil")
          
          time.sleep(2)
          
          # VERIFICATION: Check if product input appeared
          input_produk = driver.find_elements(By.XPATH, "//input[contains(@class, 'TUXTextInputCore-input')]")
          
          if len(input_produk) > 0 and input_produk[0].is_displayed():
              log("✓ VERIFIKASI BERHASIL: Input nama produk muncul")
          else:
              after_buttons = driver.find_elements(By.XPATH, "//button[.//div[text()='Next']]")
              if len(after_buttons) == len(next_buttons):
                  log("✗ VERIFIKASI GAGAL: Tombol Next masih sama, mencoba alternatif...")
                  try:
                      target_radio_wrapper.send_keys(Keys.ENTER)
                      log("Mengirim ENTER ke radio button")
                      time.sleep(2)
                  except:
                      pass
                  
                  input_produk_after = driver.find_elements(By.XPATH, "//input[contains(@class, 'TUXTextInputCore-input')]")
                  if len(input_produk_after) > 0:
                      log("✓ Metode alternatif berhasil!")
                  else:
                      raise Exception("Tidak bisa klik Next kedua setelah semua percobaan")
              else:
                  log("✓ Next kedua berhasil diklik")
      else:
          raise Exception("Tombol Next kedua tidak ditemukan")

      # E – Product title input
      log(f"STEP E: Mengisi judul produk: {nama_produk_input}")
      pi = wait.until(EC.element_to_be_clickable(
          (By.XPATH, "//input[contains(@class, 'TUXTextInputCore-input')]")))
      pi.click()
      pi.send_keys(Keys.CONTROL + "a"); pi.send_keys(Keys.BACKSPACE)
      pi.send_keys(nama_produk_input)
      log(f"✓ Input nama produk diisi dengan: {nama_produk_input}")
      time.sleep(1)

      # F – Add last (Full logic from upload.py with verification)
      log("STEP F: Mencoba klik tombol Add terakhir...")
      time.sleep(2)
      
      add_buttons = driver.find_elements(By.XPATH, "//button[.//div[text()='Add']]")
      log(f"Ditemukan {len(add_buttons)} tombol Add")
      
      target_add = None
      for i, btn in enumerate(add_buttons):
          is_vis = btn.is_displayed()
          is_en = btn.is_enabled()
          cls = btn.get_attribute("class") or ""
          log(f"  Tombol Add {i+1}: Visible={is_vis}, Enabled={is_en}, Class={cls[:80]}")
          
          if is_vis:
              parent_modal = btn.find_elements(By.XPATH, 
                  "./ancestor::div[contains(@class,'modal') or contains(@class,'Modal') or contains(@class,'dialog')]")
              if parent_modal:
                  log(f"  -> Dalam modal, prioritas tinggi")
                  target_add = btn
              elif target_add is None:
                  target_add = btn
                  log(f"  -> Target sementara")
      
      if target_add:
          log("Tombol Add target ditemukan, mencoba klik...")
          driver.execute_script("arguments[0].scrollIntoView({block:'center', behavior:'smooth'});", target_add)
          time.sleep(1)
          
          try:
              actions = ActionChains(driver)
              actions.move_to_element(target_add).click().perform()
              log("✓ Klik Add dengan ActionChains berhasil")
          except Exception as e_add:
              log(f"ActionChains gagal: {e_add}")
              try:
                  driver.execute_script("arguments[0].click();", target_add)
                  log("✓ Klik Add dengan JavaScript berhasil")
              except Exception as e_add2:
                  log(f"JavaScript gagal: {e_add2}")
                  try:
                      loc = target_add.location
                      sz = target_add.size
                      x = loc['x'] + sz['width'] // 2
                      y = loc['y'] + sz['height'] // 2
                      ac = ActionChains(driver)
                      ac.move_by_offset(x, y).click().perform()
                      ac.move_by_offset(-x, -y).perform()
                      log("✓ Klik Add dengan koordinat berhasil")
                  except Exception as e_add3:
                      raise Exception(f"Semua metode klik Add gagal: {e_add3}")
          
          time.sleep(2)
          
          # Verification (wrapped in try/except for stale elements after modal close)
          try:
              after_add = driver.find_elements(By.XPATH, "//button[.//div[text()='Add']]")
              visible_after = [b for b in after_add if b.is_displayed()]
              # Don't reference old add_buttons - they may be stale after modal close
              if len(visible_after) == 0:
                  log("✓ VERIFIKASI: Tombol Add hilang (modal tertutup)")
              else:
                  success_ind = driver.find_elements(By.XPATH, "//*[contains(text(),'added') or contains(text(),'Added')]")
                  if success_ind:
                      log("✓ VERIFIKASI: Indikator produk ditambahkan")
                  else:
                      log("⚠ VERIFIKASI: Menunggu modal tertutup...")
                      time.sleep(2)
          except Exception:
              # Stale element = DOM changed = modal closed = success
              log("✓ VERIFIKASI: DOM berubah (modal tertutup), produk berhasil ditambahkan")
      else:
          # Fallback strategies
          try:
              alt_add = driver.find_element(By.XPATH, "//button[contains(@class,'primary') and .//div[text()='Add']]")
              driver.execute_script("arguments[0].click();", alt_add)
              log("✓ Klik Add dengan selector alternatif")
          except:
              try:
                  footer_add = driver.find_element(By.XPATH, "//div[contains(@class,'footer')]//button[.//div[text()='Add']]")
                  driver.execute_script("arguments[0].click();", footer_add)
                  log("✓ Klik Add di footer")
              except Exception as e_all:
                  raise Exception(f"Tidak bisa klik tombol Add: {e_all}")
      
      time.sleep(2)
      log("✓ Produk ditambahkan")

    # ── G – Show More & Switches ──
    if skip_switches:
        log("⏭ Switches dilewati (tidak diaktifkan)")
    else:
        log("Mengatur switches...")
        safe(lambda: (
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});",
                wait.until(EC.element_to_be_clickable((By.XPATH, "//div[@data-e2e='advanced_settings_container']")))),
            time.sleep(1),
            wait.until(EC.element_to_be_clickable(
                (By.XPATH, "//div[@data-e2e='advanced_settings_container']"))).click(),
            time.sleep(2)
        ), "Show more")

        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                wait.until(EC.presence_of_element_located(
                    (By.XPATH, "//div[@data-e2e='disclose_content_container']//div[contains(@class,'Switch__content')]")))),
            time.sleep(2)
        ), "Disclose switch")

        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                wait.until(EC.presence_of_element_located(
                    (By.XPATH, "//span[contains(.,'Branded content')]/preceding-sibling::label")))),
            time.sleep(1)
        ), "Branded content")

        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                wait.until(EC.presence_of_element_located(
                    (By.XPATH, "//div[@data-e2e='aigc_container']//div[contains(@class,'Switch__content')]")))),
            time.sleep(1)
        ), "AI-generated")

    # ── H, I, J, J2 – Sounds (conditional) ──
    if add_sound:
        log("Menambahkan sound...")
        try:
            sb = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@data-button-name='sounds']")))
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sb)
            time.sleep(1); driver.execute_script("arguments[0].click();", sb); time.sleep(3)
            # Favorites
            ft = WebDriverWait(driver, 15).until(EC.element_to_be_clickable(
                (By.XPATH, "//button[@role='tab' and @aria-controls='panel-favorites']")))
            driver.execute_script("arguments[0].click();", ft); time.sleep(3)
            # + button
            plus = WebDriverWait(driver, 15).until(EC.element_to_be_clickable(
                (By.XPATH, "//button[@data-icon-only='true' and @data-type='stroke' and .//span[@data-icon='PlusBold']]")))
            driver.execute_script("arguments[0].click();", plus)
            WebDriverWait(driver, 30).until(
                lambda d: d.find_element(By.XPATH,
                    "//button[@data-icon-only='true' and @data-type='stroke' and .//span[@data-icon='PlusBold']]"
                ).get_attribute("aria-disabled") == "true"
                or not d.find_element(By.XPATH,
                    "//button[@data-icon-only='true' and @data-type='stroke' and .//span[@data-icon='PlusBold']]"
                ).is_enabled()
            )
            log("✓ Sound ditambahkan")
        except Exception as e:
            log(f"⚠ Sound: {e}")

        # ── J2 – Mute original ──
        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                WebDriverWait(driver, 10).until(EC.element_to_be_clickable(
                    (By.XPATH, "//button[@data-icon-only='true' and @data-type='text' and .//span[@data-icon='VolumeUp']]")))),
            time.sleep(1)
        ), "Mute original")
    else:
        log("⏭ Sound dilewati (tidak diaktifkan)")

    # ── K – Save (only needed after sounds modal) ──
    if add_sound:
        log("Klik Save (menutup sounds modal)...")
        try:
            sv = WebDriverWait(driver, 10).until(EC.element_to_be_clickable(
                (By.XPATH, "//div[contains(@class,'Button__content') and contains(@class,'type-primary')]//*[text()='Save']/ancestor::button | //button[.//div[contains(@class,'Button__content') and contains(@class,'type-primary') and .//text()='Save']]")))
            driver.execute_script("arguments[0].click();", sv); time.sleep(3)
            log("✓ Sounds saved")
        except:
            try:
                sv2 = driver.find_element(By.XPATH, "//div[contains(@class,'Button__content') and contains(.,'Save')]/ancestor::button")
                driver.execute_script("arguments[0].click();", sv2); time.sleep(3)
                log("✓ Sounds saved (fallback)")
            except Exception as e_sv:
                log(f"⚠ Save sounds gagal: {e_sv}")

    # ── Content Check Lite ── Jika toggle ON, klik agar menjadi OFF
    try:
        log("Memeriksa Content Check Lite...")
        content_check_clicked = False

        # Strategy 1: Cari teks 'Content check lite' lalu klik Switch__content di sebelahnya
        try:
            switch_divs = driver.find_elements(
                By.XPATH,
                "//span[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'content check')]"
                "/ancestor::div[1]//div[contains(@class,'Switch__content')]"
            )
            if not switch_divs:
                switch_divs = driver.find_elements(
                    By.XPATH,
                    "//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'content check')]"
                    "/ancestor::div[position()<=5]//div[contains(@class,'Switch')]"
                )
            for sd in switch_divs:
                cls = sd.get_attribute("class") or ""
                aria = sd.get_attribute("aria-checked") or ""
                parent = sd.find_elements(By.XPATH, "./ancestor::div[contains(@class,'Switch__root')][1]")
                parent_cls = parent[0].get_attribute("class") if parent else ""
                is_on = ("checked-true" in cls or "checked-true" in parent_cls
                         or aria == "true")
                log(f"  Switch ditemukan: class={cls[:60]}, aria-checked={aria}, is_on={is_on}")
                if is_on:
                    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sd)
                    time.sleep(0.5)
                    driver.execute_script("arguments[0].click();", sd)
                    time.sleep(1)
                    content_check_clicked = True
                    log("✓ Content Check Lite dimatikan (Strategy 1).")
                    break
        except Exception as e1:
            log(f"  Strategy 1 gagal: {e1}")

        # Strategy 2: Cari semua switch yang ON lalu cocokkan dengan teks 'content check'
        if not content_check_clicked:
            try:
                all_on_switches = driver.find_elements(
                    By.XPATH,
                    "//div[contains(@class,'Switch__root--checked-true')]//div[contains(@class,'Switch__content')]"
                    " | //div[@aria-checked='true' and contains(@class,'Switch')]"
                )
                for sw in all_on_switches:
                    # Cek apakah ada teks 'content check' di container parent
                    containers = sw.find_elements(
                        By.XPATH,
                        "./ancestor::div[position()<=5]"
                    )
                    for cont in containers:
                        txt = (cont.text or "").lower()
                        if "content check" in txt:
                            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sw)
                            time.sleep(0.5)
                            driver.execute_script("arguments[0].click();", sw)
                            time.sleep(1)
                            content_check_clicked = True
                            log("✓ Content Check Lite dimatikan (Strategy 2).")
                            break
                    if content_check_clicked:
                        break
            except Exception as e2:
                log(f"  Strategy 2 gagal: {e2}")

        # Strategy 3: Gunakan JavaScript untuk cari dan klik
        if not content_check_clicked:
            try:
                result = driver.execute_script("""
                    var spans = document.querySelectorAll('span, div, label, p');
                    for (var i = 0; i < spans.length; i++) {
                        var txt = (spans[i].textContent || '').toLowerCase().trim();
                        if (txt.includes('content check')) {
                            var parent = spans[i].closest('div[class*="jsx-"], div[class*="container"], div[class*="row"], div[class*="setting"]') || spans[i].parentElement;
                            if (!parent) continue;
                            // Cari switch di dalam parent
                            var switchEl = parent.querySelector('div[class*="Switch__content"], div[class*="switch"], div[role="switch"], input[role="switch"]');
                            if (!switchEl) {
                                // Cari di sibling
                                var siblings = parent.querySelectorAll('div[class*="Switch"]');
                                if (siblings.length > 0) switchEl = siblings[0];
                            }
                            if (switchEl) {
                                var cls = switchEl.className || '';
                                var aria = switchEl.getAttribute('aria-checked') || '';
                                var rootEl = switchEl.closest('div[class*="Switch__root"]');
                                var rootCls = rootEl ? rootEl.className : '';
                                if (cls.includes('checked-true') || rootCls.includes('checked-true') || aria === 'true') {
                                    switchEl.scrollIntoView({block: 'center'});
                                    switchEl.click();
                                    return 'clicked';
                                } else {
                                    return 'already_off';
                                }
                            }
                        }
                    }
                    return 'not_found';
                """)
                if result == 'clicked':
                    time.sleep(1)
                    content_check_clicked = True
                    log("✓ Content Check Lite dimatikan (Strategy 3 - JS).")
                elif result == 'already_off':
                    content_check_clicked = True
                    log("Content Check Lite sudah OFF (Strategy 3 - JS).")
                else:
                    log("Content Check Lite tidak ditemukan (Strategy 3 - JS).")
            except Exception as e3:
                log(f"  Strategy 3 gagal: {e3}")

        if not content_check_clicked:
            log("Content Check Lite sudah OFF atau tidak ditemukan.")
    except Exception as e:
        log(f"⚠ Content Check Lite: {e}")

    # ── L – Schedule ──
    log("Mengatur schedule...")
    WebDriverWait(driver, 15).until(EC.presence_of_element_located(
        (By.XPATH, "//*[contains(text(),'When to post')]")))
    time.sleep(1)

    sr = wait.until(EC.element_to_be_clickable(
        (By.XPATH, "//input[@name='postSchedule' and @value='schedule']/ancestor::label")))
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sr)
    time.sleep(1); driver.execute_script("arguments[0].click();", sr); time.sleep(2)

    # ── Time picker ──
    target_hour = f"{schedule_dt.hour:02d}"
    target_min_val = (schedule_dt.minute // 5) * 5
    target_min = f"{target_min_val:02d}"
    log(f"Setting time to {target_hour}:{target_min}")

    ti = wait.until(EC.element_to_be_clickable(
        (By.XPATH, "//div[contains(@class,'TUXTextInputCore')]//input[@readonly and contains(@value,':')]")))
    driver.execute_script("arguments[0].click();", ti); time.sleep(2)

    # Hour
    try:
        hs = WebDriverWait(driver, 5).until(EC.presence_of_element_located(
            (By.XPATH, f"//div[contains(@class,'tiktok-timepicker-time-picker-container')]//span[contains(@class,'tiktok-timepicker-left') and text()='{target_hour}']")))
        hs.click(); log(f"✓ Jam {target_hour}")
    except:
        try:
            hc = driver.find_element(By.XPATH, "//div[contains(@class,'tiktok-timepicker-time-picker-container')]//div[contains(@class,'tiktok-timepicker-time-scroll-container')][1]")
            driver.execute_script("arguments[0].scrollTop=0;", hc); time.sleep(1)
            hs2 = driver.find_element(By.XPATH, f"//span[contains(@class,'tiktok-timepicker-left') and text()='{target_hour}']")
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", hs2); time.sleep(.5)
            hs2.click(); log(f"✓ Jam {target_hour} (scroll)")
        except Exception as eh:
            log(f"⚠ Jam gagal: {eh}")
    time.sleep(1)

    # Minute
    try:
        ms = WebDriverWait(driver, 5).until(EC.presence_of_element_located(
            (By.XPATH, f"//div[contains(@class,'tiktok-timepicker-time-picker-container')]//span[contains(@class,'tiktok-timepicker-right') and text()='{target_min}']")))
        ms.click(); log(f"✓ Menit {target_min}")
    except:
        try:
            mcs = driver.find_elements(By.XPATH, "//div[contains(@class,'tiktok-timepicker-time-picker-container')]//div[contains(@class,'tiktok-timepicker-time-scroll-container')]")
            if len(mcs) >= 2:
                driver.execute_script("arguments[0].scrollTop=0;", mcs[1]); time.sleep(1)
            ms2 = driver.find_element(By.XPATH, f"//span[contains(@class,'tiktok-timepicker-right') and text()='{target_min}']")
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", ms2); time.sleep(.5)
            ms2.click(); log(f"✓ Menit {target_min} (scroll)")
        except Exception as em:
            log(f"⚠ Menit gagal: {em}")
    time.sleep(1)

    driver.execute_script("document.body.click();"); time.sleep(1)

    # ── Date picker ──
    target_day = str(schedule_dt.day)
    target_date_str = schedule_dt.strftime("%Y-%m-%d")
    log(f"Setting date to {target_date_str} (day {target_day})")

    di_list = driver.find_elements(By.XPATH, "//div[contains(@class,'TUXTextInputCore')]//input[@readonly]")
    for di in di_list:
        v = di.get_attribute("value") or ""
        if "-" in v and len(v) == 10 and di.is_displayed():
            driver.execute_script("arguments[0].click();", di); time.sleep(2); break

    # Check if we need to navigate to correct month
    try:
        month_title = driver.find_element(By.XPATH, "//div[contains(@class,'calendar-wrapper')]//span[contains(@class,'month-title')]")
        cal_month = month_title.text.strip()
        target_month = schedule_dt.strftime("%B")
        # Navigate forward if needed
        while cal_month != target_month:
            next_arrow = driver.find_elements(By.XPATH, "//div[contains(@class,'calendar-wrapper')]//span[contains(@class,'arrow')]")
            if len(next_arrow) >= 2:
                next_arrow[1].click(); time.sleep(1)
            cal_month = driver.find_element(By.XPATH, "//div[contains(@class,'calendar-wrapper')]//span[contains(@class,'month-title')]").text.strip()
    except:
        pass

    try:
        ds = WebDriverWait(driver, 10).until(EC.element_to_be_clickable(
            (By.XPATH, f"//div[contains(@class,'calendar-wrapper')]//span[contains(@class,'day') and contains(@class,'valid') and text()='{target_day}']")))
        ds.click(); log(f"✓ Tanggal {target_date_str}")
    except:
        try:
            spans = driver.find_elements(By.XPATH, "//div[contains(@class,'calendar-wrapper')]//span[contains(@class,'day')]")
            for s in spans:
                if s.text.strip() == target_day and s.is_displayed():
                    sc = s.get_attribute("class") or ""
                    if "header" not in sc:
                        s.click(); log(f"✓ Tanggal {target_date_str} (fallback)"); break
        except Exception as ed:
            log(f"⚠ Date gagal: {ed}")
    time.sleep(2)
    log("✓ Schedule diatur!")

    # ── Post / Schedule button ──
    log("Klik tombol Schedule...")
    time.sleep(2)

    # Specifically target the button that contains text 'Schedule' (not 'Save Draft')
    # The Schedule button has: data-e2e="post_video_button", type-primary, text='Schedule'
    schedule_clicked = False
    try:
        sch_btn = WebDriverWait(driver, 10).until(EC.element_to_be_clickable(
            (By.XPATH, "//button[@data-e2e='post_video_button' and .//div[contains(text(),'Schedule')]]")))
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sch_btn)
        time.sleep(1)
        driver.execute_script("arguments[0].click();", sch_btn)
        schedule_clicked = True
        log("✓ Tombol Schedule diklik")
    except Exception as e_sch:
        log(f"⚠ Selector utama gagal: {e_sch}, mencoba fallback...")
        # Fallback: find by text content 'Schedule' with primary type
        try:
            sch_btn2 = driver.find_element(
                By.XPATH, "//button[contains(@class,'type-primary') and .//div[contains(text(),'Schedule')]]")
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sch_btn2)
            time.sleep(1)
            driver.execute_script("arguments[0].click();", sch_btn2)
            schedule_clicked = True
            log("✓ Tombol Schedule diklik (fallback)")
        except:
            # Last resort: find all buttons, pick the one with text Schedule
            all_btns = driver.find_elements(By.XPATH, "//button")
            for b in all_btns:
                try:
                    if b.text.strip() == "Schedule" and b.is_displayed():
                        driver.execute_script("arguments[0].click();", b)
                        schedule_clicked = True
                        log("✓ Tombol Schedule diklik (text match)")
                        break
                except:
                    continue

    # Tunggu sebentar agar halaman bereaksi (popup muncul atau langsung terkirim)
    time.sleep(3)

    # Confirm popup — HANYA cari di dalam dialog/modal, agar tidak klik ulang
    # tombol Schedule yang sama
    if schedule_clicked:
        try:
            # Cek apakah ada dialog/modal konfirmasi
            confirm_btn = WebDriverWait(driver, 5).until(EC.element_to_be_clickable(
                (By.XPATH,
                 "//div[contains(@class,'modal') or contains(@class,'Modal') or contains(@class,'dialog') or contains(@class,'Dialog') or @role='dialog']"
                 "//button[.//div[text()='Schedule' or text()='Confirm']]")))
            driver.execute_script("arguments[0].click();", confirm_btn)
            log("✓ Konfirmasi popup diklik")
        except:
            # Tidak ada popup konfirmasi, mungkin langsung terjadwal
            log("ℹ Tidak ada popup konfirmasi (langsung terjadwal)")

    log("✓ Video berhasil di-schedule!")
    time.sleep(3)


# ═══════════════════════════════════════════════════════════════
# GUI APPLICATION
# ═══════════════════════════════════════════════════════════════
class TikTokSchedulerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("TikTok Multi-Upload Scheduler")
        self.root.configure(bg=BG)
        self.root.state("zoomed")  # fullscreen

        self.stop_event = threading.Event()
        self.chrome_proc = None
        self.driver = None
        self.running = False
        self.start_time = None

        # Style
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Card.TFrame", background=BG_CARD)
        style.configure("TLabel", background=BG_CARD, foreground=FG, font=("Segoe UI", 10))
        style.configure("Header.TLabel", background=BG, foreground=ACCENT, font=("Segoe UI", 18, "bold"))
        style.configure("Sub.TLabel", background=BG, foreground=FG_DIM, font=("Segoe UI", 9))
        style.configure("Accent.TButton", background=BTN_BG, foreground=BTN_FG, font=("Segoe UI", 11, "bold"), padding=10)
        style.map("Accent.TButton", background=[("active", BTN_HOVER)])
        style.configure("Danger.TButton", background=BTN_DANGER, foreground="#fff", font=("Segoe UI", 11, "bold"), padding=10)
        style.configure("Green.Horizontal.TProgressbar", troughcolor=BG_INPUT, background=SUCCESS)

        self._build_ui()

    # ───────── UI BUILD ─────────
    def _build_ui(self):
        # Header
        hdr = tk.Frame(self.root, bg=BG, pady=10)
        hdr.pack(fill="x")
        tk.Label(hdr, text="🚀 TikTok Multi-Upload Scheduler", bg=BG, fg=ACCENT,
                 font=("Segoe UI", 22, "bold")).pack(side="left", padx=20)
        self.timer_label = tk.Label(hdr, text="⏱ 00:00:00", bg=BG, fg=WARN,
                                    font=("Segoe UI", 16, "bold"))
        self.timer_label.pack(side="right", padx=20)

        # Main container with two columns - pack setelah bottom bar
        main = tk.Frame(self.root, bg=BG)
        main.pack(side="top", fill="both", expand=True, padx=15, pady=5)
        main.columnconfigure(0, weight=1)
        main.columnconfigure(1, weight=1)
        main.rowconfigure(0, weight=1)

        # ═══ LEFT COLUMN ═══
        left = tk.Frame(main, bg=BG)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))

        # Card: Video Settings
        self._card(left, "📂 Video Settings", self._build_video_settings)
        # Card: Product Settings
        self._card(left, "🏷️ Product Settings", self._build_product_settings)
        # Card: Schedule Settings
        self._card(left, "📅 Schedule Settings", self._build_schedule_settings)

        # ═══ RIGHT COLUMN ═══
        right = tk.Frame(main, bg=BG)
        right.grid(row=0, column=1, sticky="nsew", padx=(8, 0))

        # Card: Chrome Settings
        self._card(right, "🌐 Chrome Settings", self._build_chrome_settings)
        # Card: Progress
        self._card(right, "📊 Progress", self._build_progress, expand=True)

        # Bottom bar - di-pack SEBELUM main agar selalu terlihat di bawah
        bot = tk.Frame(self.root, bg=BG, pady=10)
        bot.pack(side="bottom", fill="x")

        self.start_btn = tk.Button(bot, text="▶  MULAI UPLOAD", bg="#7b2ff7", fg="white",
                                   font=("Segoe UI", 14, "bold"), relief="flat", padx=30, pady=8,
                                   activebackground=BTN_HOVER, activeforeground="white",
                                   command=self._on_start, cursor="hand2")
        self.start_btn.pack(side="left", padx=20)

        self.stop_btn = tk.Button(bot, text="⏹  STOP", bg=BTN_DANGER, fg="white",
                                  font=("Segoe UI", 14, "bold"), relief="flat", padx=30, pady=8,
                                  activebackground="#ff7777", command=self._on_stop,
                                  state="disabled", cursor="hand2")
        self.stop_btn.pack(side="left", padx=5)

        self.status_label = tk.Label(bot, text="Status: Idle", bg=BG, fg=FG_DIM,
                                     font=("Segoe UI", 11))
        self.status_label.pack(side="right", padx=20)

    def _card(self, parent, title, builder_fn, expand=False):
        frame = tk.LabelFrame(parent, text=f"  {title}  ", bg=BG_CARD, fg=ACCENT,
                               font=("Segoe UI", 11, "bold"), bd=1, relief="groove",
                               highlightbackground=BORDER, padx=12, pady=8)
        frame.pack(fill="both", expand=expand, pady=5)
        builder_fn(frame)
        return frame

    def _entry(self, parent, label, default="", row=0, width=50):
        tk.Label(parent, text=label, bg=BG_CARD, fg=FG, font=("Segoe UI", 9)).grid(
            row=row, column=0, sticky="w", pady=3)
        e = tk.Entry(parent, width=width, bg=BG_INPUT, fg=FG, insertbackground=FG,
                     font=("Segoe UI", 10), relief="flat", bd=2,
                     highlightthickness=1, highlightcolor=ACCENT)
        e.grid(row=row, column=1, sticky="ew", padx=(8, 0), pady=3)
        e.insert(0, default)
        parent.columnconfigure(1, weight=1)
        return e

    # ── Video Settings ──
    def _build_video_settings(self, f):
        row = 0
        tk.Label(f, text="Folder Video:", bg=BG_CARD, fg=FG, font=("Segoe UI", 9)).grid(
            row=row, column=0, sticky="w", pady=3)
        ff = tk.Frame(f, bg=BG_CARD)
        ff.grid(row=row, column=1, sticky="ew", padx=(8, 0), pady=3)
        self.folder_entry = tk.Entry(ff, width=40, bg=BG_INPUT, fg=FG, insertbackground=FG,
                                     font=("Segoe UI", 10), relief="flat", bd=2,
                                     highlightthickness=1, highlightcolor=ACCENT)
        self.folder_entry.pack(side="left", fill="x", expand=True)
        tk.Button(ff, text="Browse", bg=ACCENT2, fg="white", relief="flat", padx=8,
                  font=("Segoe UI", 9), command=self._browse_folder, cursor="hand2").pack(side="right", padx=(5, 0))
        f.columnconfigure(1, weight=1)

        row += 1
        tk.Label(f, text="Mulai dari video:", bg=BG_CARD, fg=FG, font=("Segoe UI", 9)).grid(
            row=row, column=0, sticky="w", pady=3)
        sf = tk.Frame(f, bg=BG_CARD)
        sf.grid(row=row, column=1, sticky="ew", padx=(8, 0), pady=3)
        self.start_from_combo = ttk.Combobox(sf, state="readonly", width=50,
                                              font=("Segoe UI", 9))
        self.start_from_combo.pack(side="left", fill="x", expand=True)
        self.start_from_combo.set("-- Pilih folder dulu --")
        self._video_list = []  # Store full video list
        tk.Button(sf, text="↻", bg=ACCENT2, fg="white", relief="flat", padx=6,
                  font=("Segoe UI", 10, "bold"), command=self._refresh_video_list,
                  cursor="hand2").pack(side="right", padx=(5, 0))

        row += 1
        self.count_entry = self._entry(f, "Jumlah upload:", "20", row)

        row += 1
        btn_frame = tk.Frame(f, bg=BG_CARD)
        btn_frame.grid(row=row, column=0, columnspan=2, sticky="w", pady=3)
        tk.Button(btn_frame, text="📝 View Upload History", bg=BG_INPUT, fg=ACCENT,
                  relief="flat", padx=10, pady=2, font=("Segoe UI", 9),
                  command=self._show_upload_history, cursor="hand2").pack(side="left")

    # ── Product Settings ──
    def _build_product_settings(self, f):
        row = 0
        self.add_product_var = tk.BooleanVar(value=True)
        cb_product = tk.Checkbutton(f, text="Tambahkan Produk", variable=self.add_product_var,
                                    bg=BG_CARD, fg=FG, selectcolor=BG_INPUT, activebackground=BG_CARD,
                                    activeforeground=FG, font=("Segoe UI", 9, "bold"), cursor="hand2")
        cb_product.grid(row=row, column=0, columnspan=2, sticky="w", pady=3)
        row += 1
        self.product_radio_entry = self._entry(f, "Nama Produk (Radio):", "", row, 45)
        row += 1
        self.product_title_entry = self._entry(f, "Judul Produk (Input E):", "beli sebelum promonya habis", row, 45)
        row += 1
        tk.Label(f, text="Deskripsi (1 per baris):", bg=BG_CARD, fg=FG,
                 font=("Segoe UI", 9)).grid(row=row, column=0, sticky="nw", pady=3)
        self.desc_text = tk.Text(f, height=5, width=45, bg=BG_INPUT, fg=FG, insertbackground=FG,
                                 font=("Segoe UI", 10), relief="flat", bd=2, wrap="word",
                                 highlightthickness=1, highlightcolor=ACCENT)
        self.desc_text.grid(row=row, column=1, sticky="ew", padx=(8, 0), pady=3)
        self.desc_text.insert("1.0", "Segera Try out di speedu.online")
        row += 1
        tk.Label(f, text="Hashtags (1 per baris):", bg=BG_CARD, fg=FG,
                 font=("Segoe UI", 9)).grid(row=row, column=0, sticky="nw", pady=3)
        self.hashtag_text = tk.Text(f, height=3, width=45, bg=BG_INPUT, fg=FG, insertbackground=FG,
                                    font=("Segoe UI", 10), relief="flat", bd=2, wrap="word",
                                    highlightthickness=1, highlightcolor=ACCENT)
        self.hashtag_text.grid(row=row, column=1, sticky="ew", padx=(8, 0), pady=3)
        self.hashtag_text.insert("1.0", "fyp\nspeedu")
        row += 1
        self.add_sound_var = tk.BooleanVar(value=False)
        cb = tk.Checkbutton(f, text="Tambahkan Sound (dari Favorites)", variable=self.add_sound_var,
                            bg=BG_CARD, fg=FG, selectcolor=BG_INPUT, activebackground=BG_CARD,
                            activeforeground=FG, font=("Segoe UI", 9), cursor="hand2")
        cb.grid(row=row, column=0, columnspan=2, sticky="w", pady=3)
        row += 1
        self.skip_switches_var = tk.BooleanVar(value=False)
        cb_switches = tk.Checkbutton(f, text="Skip Switches (Show More, Disclose, Branded, AI-generated)",
                                     variable=self.skip_switches_var,
                                     bg=BG_CARD, fg=FG, selectcolor=BG_INPUT, activebackground=BG_CARD,
                                     activeforeground=FG, font=("Segoe UI", 9), cursor="hand2")
        cb_switches.grid(row=row, column=0, columnspan=2, sticky="w", pady=3)

        row += 1
        self.add_location_var = tk.BooleanVar(value=False)
        cb_location = tk.Checkbutton(f, text="Tambahkan Lokasi", variable=self.add_location_var,
                                     bg=BG_CARD, fg=FG, selectcolor=BG_INPUT, activebackground=BG_CARD,
                                     activeforeground=FG, font=("Segoe UI", 9, "bold"), cursor="hand2")
        cb_location.grid(row=row, column=0, columnspan=2, sticky="w", pady=3)
        row += 1
        self.location_entry = self._entry(f, "Lokasi:", "", row, 45)

    # ── Schedule Settings ──
    def _build_schedule_settings(self, f):
        row = 0
        tk.Label(f, text="Mulai Schedule:", bg=BG_CARD, fg=FG, font=("Segoe UI", 9)).grid(
            row=row, column=0, sticky="w", pady=3)
        tf = tk.Frame(f, bg=BG_CARD)
        tf.grid(row=row, column=1, sticky="ew", padx=(8, 0), pady=3)
        tomorrow = (datetime.now() + timedelta(days=1))
        self.hour_entry = tk.Entry(tf, width=4, bg=BG_INPUT, fg=FG, insertbackground=FG,
                                   font=("Segoe UI", 10), relief="flat", justify="center")
        self.hour_entry.pack(side="left"); self.hour_entry.insert(0, "01")
        tk.Label(tf, text=":", bg=BG_CARD, fg=FG, font=("Segoe UI", 10, "bold")).pack(side="left")
        self.minute_entry = tk.Entry(tf, width=4, bg=BG_INPUT, fg=FG, insertbackground=FG,
                                     font=("Segoe UI", 10), relief="flat", justify="center")
        self.minute_entry.pack(side="left"); self.minute_entry.insert(0, "00")
        tk.Label(tf, text="  Tanggal:", bg=BG_CARD, fg=FG, font=("Segoe UI", 9)).pack(side="left", padx=(10, 0))
        self.date_entry = tk.Entry(tf, width=12, bg=BG_INPUT, fg=FG, insertbackground=FG,
                                   font=("Segoe UI", 10), relief="flat", justify="center")
        self.date_entry.pack(side="left", padx=(5, 0))
        self.date_entry.insert(0, tomorrow.strftime("%Y-%m-%d"))
        f.columnconfigure(1, weight=1)

        row += 1
        self.interval_entry = self._entry(f, "Interval (menit):", "60", row)

    # ── Chrome Settings ──
    def _build_chrome_settings(self, f):
        self.userdata_entry = self._entry(f, "User Data Dir:", r"C:\tiktok_automation\user_data\1", 0, 45)
        self.port_entry = self._entry(f, "Debug Port:", "9222", 1)

    # ── Progress ──
    def _build_progress(self, f):
        pf = tk.Frame(f, bg=BG_CARD)
        pf.pack(fill="x", pady=(0, 5))
        self.progress_label = tk.Label(pf, text="0 / 0  (0%)", bg=BG_CARD, fg=ACCENT,
                                       font=("Segoe UI", 11, "bold"))
        self.progress_label.pack(side="left")
        self.eta_label = tk.Label(pf, text="", bg=BG_CARD, fg=FG_DIM, font=("Segoe UI", 9))
        self.eta_label.pack(side="right")

        self.progress_bar = ttk.Progressbar(f, mode="determinate", length=400,
                                            style="Green.Horizontal.TProgressbar")
        self.progress_bar.pack(fill="x", pady=(0, 8))

        self.log_box = scrolledtext.ScrolledText(f, bg="#0a0a15", fg="#aaffaa",
                                                  font=("Consolas", 9), relief="flat",
                                                  insertbackground=SUCCESS, wrap="word")
        self.log_box.pack(fill="both", expand=True)
        self.log_box.tag_config("error", foreground=ERROR)
        self.log_box.tag_config("success", foreground=SUCCESS)
        self.log_box.tag_config("warn", foreground=WARN)
        self.log_box.tag_config("info", foreground=ACCENT)

    # ───────── ACTIONS ─────────
    def _browse_folder(self):
        d = filedialog.askdirectory()
        if d:
            self.folder_entry.delete(0, tk.END)
            self.folder_entry.insert(0, d)
            self._refresh_video_list()

    def _refresh_video_list(self):
        """Populate the dropdown with video files from the selected folder."""
        folder = self.folder_entry.get().strip()
        if not folder or not os.path.isdir(folder):
            self.start_from_combo['values'] = []
            self.start_from_combo.set("-- Folder tidak valid --")
            self._video_list = []
            return

        exts = (".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv")
        videos = sorted(
            [f for f in os.listdir(folder) if f.lower().endswith(exts)],
            key=lambda x: os.path.getmtime(os.path.join(folder, x))
        )
        self._video_list = videos

        # Load upload history to mark already uploaded
        db = load_db()
        folder_name = os.path.basename(folder)
        uploaded = get_uploaded_videos(folder_name, db)

        display_list = []
        for i, v in enumerate(videos):
            status = "✓" if v in uploaded else ""
            display_list.append(f"{i+1}. {v} {status}")

        self.start_from_combo['values'] = display_list
        if display_list:
            self.start_from_combo.current(0)
        else:
            self.start_from_combo.set("-- Tidak ada video --")

    def _show_upload_history(self):
        """Show upload history in a popup window with delete capability."""
        win = tk.Toplevel(self.root)
        win.title("Upload History")
        win.geometry("650x500")
        win.configure(bg=BG)
        win.attributes('-topmost', True)

        tk.Label(win, text="📝 Upload History", bg=BG, fg=ACCENT,
                 font=("Segoe UI", 16, "bold")).pack(pady=10)

        # Style Treeview
        style = ttk.Style()
        style.configure("Treeview", background="#0a0a15", foreground="#aaffaa", 
                        fieldbackground="#0a0a15", font=("Consolas", 10), borderwidth=0)
        style.map('Treeview', background=[('selected', ACCENT2)], foreground=[('selected', 'white')])
        style.configure("Treeview.Heading", background=BG_CARD, foreground=FG, font=("Segoe UI", 10, "bold"))

        tree_frame = tk.Frame(win, bg=BG)
        tree_frame.pack(fill="both", expand=True, padx=15, pady=(0, 10))

        scroll_y = ttk.Scrollbar(tree_frame)
        scroll_y.pack(side="right", fill="y")

        tree = ttk.Treeview(tree_frame, columns=("folder", "video"), show="headings",
                            yscrollcommand=scroll_y.set, selectmode="extended")
        tree.heading("folder", text="Folder")
        tree.column("folder", width=200, anchor="w")
        tree.heading("video", text="Video")
        tree.column("video", width=400, anchor="w")
        tree.pack(side="left", fill="both", expand=True)
        scroll_y.config(command=tree.yview)

        def refresh_tree():
            for item in tree.get_children():
                tree.delete(item)
            db = load_db()
            if not db:
                tree.insert("", tk.END, values=("Belum ada riwayat upload.", ""))
            else:
                for folder_name, videos in db.items():
                    for v in videos:
                        tree.insert("", tk.END, values=(folder_name, v))

        refresh_tree()

        def delete_selected():
            selected = tree.selection()
            if not selected:
                messagebox.showwarning("Peringatan", "Pilih riwayat yang ingin dihapus!", parent=win)
                return
            
            # Don't delete if it's the empty message
            first_val = tree.item(selected[0], "values")
            if first_val and first_val[0] == "Belum ada riwayat upload.": return

            if messagebox.askyesno("Konfirmasi", f"Hapus {len(selected)} riwayat terpilih?", parent=win):
                db = load_db()
                changed = False
                for item in selected:
                    vals = tree.item(item, "values")
                    if vals and len(vals) == 2:
                        folder, video = vals[0], vals[1]
                        if folder in db and video in db[folder]:
                            db[folder].remove(video)
                            changed = True
                            if not db[folder]:
                                del db[folder]
                if changed:
                    save_db(db)
                    refresh_tree()
                    self._refresh_video_list()

        def clear_all():
            db = load_db()
            if not db: return
            if messagebox.askyesno("Konfirmasi", "Hapus SEMUA riwayat upload?", parent=win):
                save_db({})
                refresh_tree()
                self._refresh_video_list()

        btn_frame = tk.Frame(win, bg=BG)
        btn_frame.pack(fill="x", padx=15, pady=(0, 10))

        tk.Button(btn_frame, text="🗑️ Hapus Terpilih", bg="#ff9800", fg="white", relief="flat",
                  padx=15, pady=5, font=("Segoe UI", 10, "bold"),
                  command=delete_selected, cursor="hand2").pack(side="left")

        tk.Button(btn_frame, text="💣 Hapus Semua", bg=BTN_DANGER, fg="white", relief="flat",
                  padx=15, pady=5, font=("Segoe UI", 10, "bold"),
                  command=clear_all, cursor="hand2").pack(side="left", padx=10)

        tk.Button(btn_frame, text="Tutup", bg=BG_INPUT, fg=FG, relief="flat",
                  padx=20, pady=5, font=("Segoe UI", 10),
                  command=win.destroy, cursor="hand2").pack(side="right")

    def _log(self, msg, tag=None):
        ts = datetime.now().strftime("%H:%M:%S")
        auto_tag = tag
        if not auto_tag:
            if "✓" in msg or "berhasil" in msg.lower():
                auto_tag = "success"
            elif "⚠" in msg or "gagal" in msg.lower():
                auto_tag = "warn"
            elif "❌" in msg or "error" in msg.lower():
                auto_tag = "error"
        def _do():
            self.log_box.insert(tk.END, f"[{ts}] {msg}\n", auto_tag or "")
            self.log_box.see(tk.END)
        self.root.after(0, _do)

    def _update_progress(self, current, total):
        pct = int(current / total * 100) if total else 0
        def _do():
            self.progress_bar["maximum"] = total
            self.progress_bar["value"] = current
            self.progress_label.config(text=f"{current} / {total}  ({pct}%)")
        self.root.after(0, _do)

    def _update_timer(self):
        if not self.running:
            return
        elapsed = time.time() - self.start_time
        h = int(elapsed // 3600)
        m = int((elapsed % 3600) // 60)
        s = int(elapsed % 60)
        self.timer_label.config(text=f"⏱ {h:02d}:{m:02d}:{s:02d}")
        self.root.after(1000, self._update_timer)

    def _set_status(self, text, color=FG_DIM):
        self.root.after(0, lambda: self.status_label.config(text=f"Status: {text}", fg=color))

    def _on_start(self):
        # Validate
        folder = self.folder_entry.get().strip()
        if not folder or not os.path.isdir(folder):
            messagebox.showerror("Error", "Folder video tidak valid!")
            return

        add_product = self.add_product_var.get()
        product_radio = self.product_radio_entry.get().strip()
        if add_product and not product_radio:
            messagebox.showerror("Error", "Nama Produk (Radio) harus diisi!")
            return

        self.running = True
        self.stop_event.clear()
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self.start_time = time.time()
        self._update_timer()
        self.log_box.delete("1.0", tk.END)

        threading.Thread(target=self._run_automation, daemon=True).start()

    def _on_stop(self):
        self.stop_event.set()
        self._set_status("Stopping...", WARN)
        self._log("⏹ Stop requested by user", "warn")

    def _run_automation(self):
        try:
            self._set_status("Starting...", ACCENT)

            # ── Gather inputs ──
            folder = self.folder_entry.get().strip()
            folder_name = os.path.basename(folder)
            start_from_idx = self.start_from_combo.current()
            start_from = max(0, start_from_idx) if start_from_idx >= 0 else 0
            count = int(self.count_entry.get().strip() or "20")
            product_radio = self.product_radio_entry.get().strip()
            product_title = self.product_title_entry.get().strip()
            add_sound = self.add_sound_var.get()
            add_product = self.add_product_var.get()
            skip_switches = self.skip_switches_var.get()
            add_location = self.add_location_var.get()
            location_text = self.location_entry.get().strip() if add_location else None
            descs_raw = self.desc_text.get("1.0", tk.END).strip()
            descs = [d.strip() for d in descs_raw.split("\n") if d.strip()]
            if not descs:
                descs = [""]
            hashtags_raw = self.hashtag_text.get("1.0", tk.END).strip()
            hashtags = [h.strip() for h in hashtags_raw.split("\n") if h.strip()]
            hour = int(self.hour_entry.get().strip() or "1")
            minute = int(self.minute_entry.get().strip() or "0")
            date_str = self.date_entry.get().strip()
            interval = int(self.interval_entry.get().strip() or "60")
            userdata = self.userdata_entry.get().strip()
            port = self.port_entry.get().strip() or "9222"

            start_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=hour, minute=minute)

            # ── List videos ──
            exts = (".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv")
            all_videos = sorted(
                [f for f in os.listdir(folder) if f.lower().endswith(exts)],
                key=lambda x: os.path.getmtime(os.path.join(folder, x))
            )
            self._log(f"📂 Folder: {folder} ({len(all_videos)} video)", "info")

            # Filter already uploaded
            db = load_db()
            uploaded = get_uploaded_videos(folder_name, db)

            # Apply start_from (0-indexed from dropdown)
            available = all_videos[start_from:]
            # Filter out already uploaded
            to_upload = [v for v in available if v not in uploaded][:count]

            if not to_upload:
                self._log("❌ Tidak ada video untuk diupload!", "error")
                self._finish()
                return

            total = len(to_upload)
            self._log(f"🎬 {total} video akan diupload", "info")
            self._update_progress(0, total)

            # ── Open Chrome ──
            self._log(f"🌐 Membuka Chrome (port {port})...", "info")
            self.chrome_proc = open_chrome_debug(userdata, port)
            time.sleep(2)
            self.driver = connect_selenium(port)
            self._log("✓ Chrome terhubung!", "success")

            # ── Upload loop (JS injection approach) ──
            for idx, video_name in enumerate(to_upload):
                if self.stop_event.is_set():
                    self._log("⏹ Dihentikan oleh user", "warn")
                    break

                video_path = os.path.join(folder, video_name)
                current_dt = start_dt + timedelta(minutes=interval * idx)
                desc = descs[idx % len(descs)]

                self._log(f"\n{'═'*50}", "info")
                self._log(f"📹 [{idx+1}/{total}] {video_name}", "info")
                self._log(f"⏰ Schedule: {current_dt.strftime('%Y-%m-%d %H:%M')}", "info")
                self._log(f"📝 Deskripsi: {desc[:50]}...", "info")
                self._set_status(f"Uploading {idx+1}/{total}: {video_name}", ACCENT)

                try:
                    # 1. Navigate to fresh upload page
                    self._log("Navigasi ke halaman upload baru...", "info")
                    navigate_upload_page(self.driver, force=(idx > 0))
                    time.sleep(3)

                    # 2. Upload file via Selenium robust helper
                    self._log(f"Uploading {video_name}...")
                    inject_video_file(self.driver, video_path)
                    self._log(f"✓ File disuntikkan: {video_name}", "success")
                    time.sleep(5)

                    # 3. Selenium automation
                    self._log("▶ Selenium automation dimulai...", "info")
                    do_post_video(
                        driver=self.driver,
                        deskripsi=desc,
                        nama_produk_radio=product_radio,
                        nama_produk_input=product_title,
                        log=lambda m: self._log(m, "info"),
                        schedule_dt=current_dt,
                        stop_event=self.stop_event,
                        add_sound=add_sound,
                        add_product=add_product,
                        skip_switches=skip_switches,
                        hashtags=hashtags,
                        location=location_text
                    )
                    
                    if not self.stop_event.is_set():
                        self._log(f"✓ {video_name} berhasil di-schedule!", "success")
                        mark_uploaded(folder_name, video_name, db)

                except Exception as e:
                    self._log(f"❌ Error pada {video_name}: {e}", "error")

                self._update_progress(idx + 1, total)

                # Wait before next upload
                if idx < total - 1 and not self.stop_event.is_set():
                    self._log("Menunggu 10 detik sebelum video berikutnya...", "info")
                    time.sleep(10)

            # ── Done ──
            self._log(f"\n🎉 SELESAI! {total} video telah diproses.", "success")
            self._set_status("Selesai!", SUCCESS)

            # Sound notification
            try:
                for _ in range(3):
                    winsound.Beep(1000, 300)
                    time.sleep(0.2)
                winsound.Beep(1500, 500)
            except:
                pass

        except Exception as e:
            self._log(f"❌ Fatal error: {e}", "error")
            self._set_status(f"Error: {e}", ERROR)
        finally:
            self._finish()

    def _finish(self):
        self.running = False
        # Close Chrome properly
        if self.chrome_proc:
            self._log(f"Menutup Chrome (PID: {self.chrome_proc.pid})...", "info")
            try:
                if self.driver:
                    self.driver.quit()
                    time.sleep(2)
            except:
                pass
            try:
                self.chrome_proc.terminate()
                self.chrome_proc.wait(timeout=5)
            except:
                pass
            # Force kill jika masih hidup
            try:
                subprocess.run(['taskkill', '/PID', str(self.chrome_proc.pid), '/F', '/T'],
                               capture_output=True, timeout=10)
            except:
                pass
            self._log("✓ Chrome ditutup.", "success")
            self.chrome_proc = None
            self.driver = None

        self.root.after(0, lambda: self.start_btn.config(state="normal"))
        self.root.after(0, lambda: self.stop_btn.config(state="disabled"))


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    root = tk.Tk()
    app = TikTokSchedulerApp(root)
    root.mainloop()
