
buat di localhost:5000/tiktok
buatkan web yang berjudul TikTok Auto Uploader
dengan fitur :

1. video settings :
- folder video : memilih folder yang berisi video yang akan diupload (ada button browse
- Mulai dari video. ada dropdown list berisi video yang sudah diurutkan. video yang dipilih itu urutan pertama yang diupload
2. product settings:
-checklist tambahkan product. Jika dicheck
user mengisi : Nama Produk (Radio), Judul produk, deskripsi(text area)
hashtag : gunakan pemisah #
-checklist skip switches
3. system settings:
schedule date dan jam menit nya
state : gunakan dropdown state yang tersedia
4. ada live log (setiap step baik memeriksa adanya elemen maupun klik ataupun mengisi elemen ditampilkan di live log agar terlihat errornya
ketika klik mulai maka : 
buka https://www.tiktok.com/tiktokstudio/upload gunakan browser bahasa inggris sesuai dengan state yang dipilih
kemudian step :
1. upload video
periksa harus exist terlebih dahulu :
     EC.presence_of_element_located((By.XPATH, "//input[@type='file']")))
 wait.until(EC.presence_of_element_located((By.XPATH, "//button[@data-e2e='select_video_button' or @aria-label='Select video']")))
atau
 await page.getByRole('button', { name: 'Pilih video untuk diunggah' }).click();
  await page.getByRole('button', { name: 'Pilih video', exact: true }).click();
  await page.getByRole('button', { name: 'Pilih video', exact: true }).setInputFiles('grok-video-bb6e19f8-aad5-4b4e-99c2-34aead78467a.mp4'); input filesnya dari video yang telah dipilih


atau

     'input[type="file"][accept*="video"]',
        'input[type="file"][accept*="mp4"]',
        'input[type="file"]',

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
lanjut setelah berhasil upload periksa
2. jika ada pop up
deteksi dulu apakah ada baru eksekusi:
await page.getByRole('dialog').getByText('Pemeriksaan hak cipta musik').click();
  await page.getByRole('dialog').getByText('Pemeriksaan konten ringan').click();
hapus checkbox
  // await expect(page.locator('label').filter({ hasText: 'Pemeriksaan konten ringan' }).getByRole('img')).toBeVisible();
jika masih checkbox matikan checkboxnya
 await page.locator('label').filter({ hasText: 'Pemeriksaan konten ringan' }).getByRole('img').click();
  await page.locator('div:nth-child(2) > .jsx-1661904819.item-heading > .jsx-1661904819.item-label > .jsx-1661904819 > .Checkbox__root > .Checkbox__inputWrapper > .Checkbox__iconWrapper').click();

  await page.getByText('Aktifkan pemeriksaan konten') exist
  await page.getByRole('dialog').getByText('Pemeriksaan hak cipta musik') exist
  await page.getByRole('dialog').getByText('Pemeriksaan konten ringan') exist
  await page.locator('label').filter({ hasText: 'Pemeriksaan konten ringan' }).click();
  await page.locator('label').filter({ hasText: 'Pemeriksaan konten ringan' }).getByRole('img').click();
  await page.locator('label').filter({ hasText: 'Pemeriksaan konten ringan' }).getByRole('img').click();
  // await expect(page.locator('div:nth-child(2) > .jsx-1661904819.item-heading > .jsx-1661904819.item-label > .jsx-1661904819 > .Checkbox__root > .Checkbox__inputWrapper > .Checkbox__iconWrapper')).toBeVisible();
  // await expect(page.locator('div:nth-child(2) > .jsx-1661904819.item-heading > .jsx-1661904819.item-label > .jsx-1661904819')).toBeVisible();
  await page.locator('div:nth-child(2) > .jsx-1661904819.item-heading > .jsx-1661904819.item-label > .jsx-1661904819 > .Checkbox__root > .Checkbox__inputWrapper > .Checkbox__iconWrapper').click();
  // await expect(page.locator('label').filter({ hasText: 'Pemeriksaan konten ringan' }).getByRole('img')).toBeVisible();

11. periksa apakah sudah upload 
<span class="TUXText TUXText--tiktok-sans TUXText--weight-medium" data-tt="components_PublishStageLabel_TUXText" style="color: inherit; font-size: inherit;">12 Mei 4.40 AM</span>

3. pop up kedua
periksa pop up 2
await expect(page.getByText('Fitur pengeditan baru')) periksa apakah exist
kemudian klik   await page.getByRole('button', { name: 'Mengerti' }).click();

4. pengisian deskripsi
  await page.locator('.public-DraftStyleDefault-block').click();
atau 
    (By.XPATH, "//div[@role='textbox'] | //div[contains(@class, 'notranslate public-DraftEditor-content')]")))
atau
  (By.XPATH, "//div[@role='textbox'] | //div[contains(@class, 'notranslate public-DraftEditor-content')]")))

5. pengisian hashtag di elemen deskripsi tetapi diisinya setelah deskripsi, kata dipisah dalam koma, contoh : hashtag : fyp,speedu,kedinasan menjadi #fyp #speedu #kedinasan setelah mengetik klik tab. baru spasi
5. cari lokasi (jika dichecklist)
  # Cari input lokasi
            loc_input = WebDriverWait(driver, 10).until(EC.presence_of_element_located(
                (By.XPATH, "//input[@placeholder='Search locations' and @role='input']")))
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", loc_input)
  await page.getByRole('textbox', { name: 'Cari lokasi' })
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
6. Add Product
 add_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[.//div[text()='Add']]")))
periksa pop up exist 
  await page.getByRole('dialog', { name: 'Tambah tautan' })
maka
 await page.getByRole('button', { name: 'Berikutnya' }).click(); Bahasa inggris nya next    n1 = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[.//div[text()='Next']]")))

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

  await page.getByPlaceholder('Cari produk')
   # C – Search product then select radio button
      log(f"STEP C: Mencari produk: {nama_produk_radio[:60]}...")
      
      # C1 – Cari input search products & ketik nama produk
      try:
          search_input = WebDriverWait(driver, 10).until(
              EC.presence_of_element_located((By.XPATH, "//input[@placeholder='Search products']"))) isi dengan nama produk (radio)
klik tombol search
    # C2 – Klik tombol search (icon svg)
          try:
              search_icon = driver.find_element(By.XPATH,
                  "//div[contains(@class,'product-search-icon')]")
pilih radio button sesuai nama produk radio
 xpath_produk = f"//input[@type='radio' and @name='{nama_produk_radio}']"
 target_radio_wrapper = radio.find_element(By.XPATH, "./..")
      driver.execute_script("arguments[0].scrollIntoView({block:'center'});", target_radio_wrapper)
 target_radio_wrapper.click()
   next_buttons = driver.find_elements(By.XPATH, "//button[.//div[text()='Next']]")
<button class="TUXButton TUXButton--default TUXButton--medium TUXButton--primary" aria-disabled="false" type="button"><div class="TUXButton-content"><div class="TUXButton-label">Berikutnya</div></div></button>

selanjutnya isi textbox sesuai judul produk
 await page.getByRole('textbox', { name: 'Nama produk' })
 // await expect(page.getByRole('textbox', { name: 'Nama produk' })).toHaveValue('X-PRIME Tablet Matepad Pro S25');
isi sesuai judul produk
seanjutnya
 await page.getByRole('button', { name: 'Tambah' }) (Add)
7. Mengatur schedule
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
8. switches
  driver.execute_script("arguments[0].scrollIntoView({block:'center'});",
                wait.until(EC.element_to_be_clickable((By.XPATH, "//div[@data-e2e='advanced_settings_container']")))),
           
            wait.until(EC.element_to_be_clickable(
                (By.XPATH, "//div[@data-e2e='advanced_settings_container']"))).click(),
            time.sleep(2)
        ), "Show more")

        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                wait.until(EC.presence_of_element_located(
                    (By.XPATH, "//div[@data-e2e='disclose_content_container']//div[contains(@class,'Switch__content')]")))),
           
        ), "Disclose switch")

        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                wait.until(EC.presence_of_element_located(
                    (By.XPATH, "//span[contains(.,'Branded content')]/preceding-sibling::label")))),
         
        ), "Branded content")

        safe(lambda: (
            driver.execute_script("arguments[0].click();",
                wait.until(EC.presence_of_element_located(
                    (By.XPATH, "//div[@data-e2e='aigc_container']//div[contains(@class,'Switch__content')]")))),
          
        ), "AI-generated")

8. pemeriksaan content check lite
<div class="jsx-2629471817 headline-wrapper"><span class="TUXText TUXText--tiktok-sans TUXText--weight-medium headline" style="color: var(--ui-text-1); font-size: 14px;">Pemeriksaan konten ringan</span><div class="Tooltip__root info-tooltip"><span class="jsx-2627041470 info-tooltip-icon"><span role="img" class="px-icon " data-icon="Info" data-testid="Info"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="14" height="14" role="img" focusable="false" data-icon="info" aria-hidden="true" fill="var(--ui-text-placeholder)" will-change="auto" transform="rotate(0)"><path opacity="0.989" d="M11.999 2c-5.523 0-10 4.477-10 10s4.477 10 10 10 10-4.477 10-10-4.477-10-10-10m0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16m0 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2m-1 3a1 1 0 0 0-1 1c0 .482.359.842.812.938l-.593 2.874c-.232 1.161.598 2.188 1.78 2.188h1a1 1 0 0 0 0-2h-.78l.75-3.812a.986.986 0 0 0-.97-1.188z"></path></svg></span></span></div><div class="jsx-2629471817 headline-switch"><div class="Switch__root" data-layout="switch-root"><div class="Switch__content Switch__content--checked-false" aria-checked="false" data-state="unchecked" data-disabled="false"><span data-part="thumb" data-state="unchecked" class="Switch__thumb Switch__thumb--checked-false"></span><input role="switch" type="checkbox" aria-hidden="true" id=":rn9:" tabindex="0" class="Switch__input" style="appearance: none;"></div></div></div></div>
9. klik tombol schedule
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

