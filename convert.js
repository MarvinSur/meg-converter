const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const puppeteer = require('puppeteer');

const WORK_DIR = path.join(__dirname, 'workspace');
const INPUT_ZIP_PATH = path.join(__dirname, 'input.zip');
const EXTRACT_DIR = path.join(WORK_DIR, 'extracted');
const FLAT_DIR = path.join(WORK_DIR, 'flattened');
const DOWNLOADS_DIR = path.join(WORK_DIR, 'downloads');
const FINAL_ZIP_PATH = path.join(__dirname, 'meg-bedrock.zip');
const PLUGIN_PATH = path.join(__dirname, 'geyser_model_engine_packer (1).js');

// Utility to clean directory
function cleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

// Recursively find all bbmodels
function findBbmodels(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            findBbmodels(fullPath, fileList);
        } else if (file.endsWith('.bbmodel')) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

// Ensure unique filenames by prefixing with parent folder name
function getUniqueName(filePath, extractDir) {
    const relativePath = path.relative(extractDir, filePath);
    // Replace folder separators with underscores, and replace spaces with underscores
    let safeName = relativePath.split(path.sep).join('_');
    safeName = safeName.replace(/ /g, '_');
    return safeName;
}

async function run() {
    if (!fs.existsSync(INPUT_ZIP_PATH)) {
        console.error("input.zip not found! Make sure it is downloaded first.");
        process.exit(1);
    }

    console.log("=== 1. PREPARING WORKSPACE ===");
    cleanDir(WORK_DIR);
    cleanDir(EXTRACT_DIR);
    cleanDir(FLAT_DIR);
    cleanDir(DOWNLOADS_DIR);
    if (fs.existsSync(FINAL_ZIP_PATH)) fs.unlinkSync(FINAL_ZIP_PATH);

    console.log("=== 2. EXTRACTING INPUT ===");
    
    const zip = new AdmZip(INPUT_ZIP_PATH);
    zip.extractAllTo(EXTRACT_DIR, true);

    console.log("=== 3. FLATTENING & RENAMING ===");
    const bbmodels = findBbmodels(EXTRACT_DIR);
    console.log(`Found ${bbmodels.length} .bbmodel files.`);
    
    const flatFiles = [];
    for (const file of bbmodels) {
        const uniqueName = getUniqueName(file, EXTRACT_DIR);
        const dest = path.join(FLAT_DIR, uniqueName);
        fs.copyFileSync(file, dest);
        flatFiles.push({ path: dest, name: uniqueName });
        console.log(`- Prepared: ${uniqueName}`);
    }

    if (flatFiles.length === 0) {
        console.log("No .bbmodel files found in the ZIP. Exiting.");
        process.exit(0);
    }

    console.log("=== 4. LAUNCHING BLOCKBENCH HEADLESS ===");
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--window-size=1280,720',
            '--enable-unsafe-swiftshader',
            '--use-gl=swiftshader',
            '--disable-gpu'
        ]
    });

    const page = await browser.newPage();
    
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOADS_DIR
    });

    page.on('dialog', async dialog => await dialog.accept());
    page.on('console', msg => console.log('BLOCKBENCH:', msg.text()));

    console.log("Navigating to Blockbench...");
    await page.goto('https://web.blockbench.net/', { waitUntil: 'networkidle2' });
    
    console.log("Waiting for Blockbench Engine to initialize...");
    // Wait for the global Blockbench object instead of DOM elements, ensuring the API is ready
    await page.waitForFunction('typeof Blockbench !== "undefined"', { timeout: 30000 });
    // Additional wait for internal setup to complete
    await new Promise(r => setTimeout(r, 5000));

    console.log("Loading plugin...");
    const pluginCode = fs.readFileSync(PLUGIN_PATH, 'utf-8');
    await page.evaluate((code) => {
        // Intercept BBPlugin.register to reliably get the plugin definition
        window.injectedPluginData = null;
        const originalRegister = BBPlugin.register;
        BBPlugin.register = function(id, data) {
            window.injectedPluginData = data;
            return originalRegister.apply(this, arguments);
        };

        const script = document.createElement('script');
        script.textContent = code;
        document.body.appendChild(script);
        
        // Force onload() to execute so the actions get registered!
        if (window.injectedPluginData && typeof window.injectedPluginData.onload === 'function') {
            window.injectedPluginData.onload();
            console.log("Plugin onload() successfully intercepted and triggered.");
        } else {
            console.error("Failed to intercept plugin data!");
        }
    }, pluginCode);

    // Wait a bit for plugin to initialize
    await new Promise(r => setTimeout(r, 2000));

    console.log("Setting up native file upload listener...");
    await page.evaluate(() => {
        if (!document.getElementById('puppeteer_upload')) {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.id = 'puppeteer_upload';
            input.addEventListener('change', (e) => {
                const dt = new DataTransfer();
                for (let f of e.target.files) dt.items.add(f);
                const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
                document.body.dispatchEvent(dropEvent);
            });
            document.body.appendChild(input);
        }
    });

    const FINAL_EXTRACT_DIR = path.join(WORK_DIR, 'final_extracted');
    cleanDir(FINAL_EXTRACT_DIR);

    console.log("Loading .bbmodel files into Blockbench (batched for speed & memory)...");
    const batchSize = 50;
    
    for (let i = 0; i < flatFiles.length; i += batchSize) {
        const batch = flatFiles.slice(i, i + batchSize);
        console.log(`\n--- Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(flatFiles.length / batchSize)} ---`);
        
        const batchPaths = batch.map(f => f.path);
        
        const inputHandle = await page.$('#puppeteer_upload');
        await inputHandle.uploadFile(...batchPaths);
        
        // Wait for Blockbench to process the dropped files
        await new Promise(r => setTimeout(r, 3000));
        
        console.log(`Triggering Export for batch ${Math.floor(i / batchSize) + 1}...`);
        await page.evaluate(() => {
            if (typeof BarItems !== 'undefined' && BarItems['export_all_geysermodelengine']) {
                BarItems['export_all_geysermodelengine'].click();
            } else if (typeof export_all_action !== 'undefined') {
                export_all_action.click();
            } else {
                console.error("Plugin action not found!");
            }
        });

        console.log("Waiting for batch download to finish...");
        let downloadedFilePath = null;
        let retries = 60; // 60 seconds timeout per batch
        
        while (retries > 0) {
            const files = fs.readdirSync(DOWNLOADS_DIR);
            const zipFile = files.find(f => f.endsWith('.zip') && !f.endsWith('.crdownload'));
            if (zipFile) {
                downloadedFilePath = path.join(DOWNLOADS_DIR, zipFile);
                break;
            }
            await new Promise(r => setTimeout(r, 1000));
            retries--;
        }

        if (!downloadedFilePath) {
            console.error("Batch download failed or timed out.");
            process.exit(1);
        }

        console.log(`Extracting batch zip...`);
        const zip = new AdmZip(downloadedFilePath);
        zip.extractAllTo(FINAL_EXTRACT_DIR, true);

        // Delete the zip to prepare for next batch
        fs.unlinkSync(downloadedFilePath);

        console.log(`Closing Blockbench tabs to free RAM...`);
        await page.evaluate(() => {
            if (typeof ModelProject !== 'undefined' && ModelProject.all) {
                // Duplicate array because closing projects mutates it
                [...ModelProject.all].forEach(p => {
                    if (p && typeof p.close === 'function') p.close();
                });
            }
        });
        
        await new Promise(r => setTimeout(r, 1000));
    }

    await browser.close();

    console.log("=== 5. PACKAGING FINAL GEYSERMC ZIP ===");
    const finalZip = new AdmZip();
    finalZip.addLocalFolder(FINAL_EXTRACT_DIR);
    finalZip.writeZip(FINAL_ZIP_PATH);
    console.log(`Success! Merged all batches and created ${FINAL_ZIP_PATH}`);
    
    // Optional cleanup
    cleanDir(WORK_DIR);
    console.log("Done.");
}

run().catch(console.error);
