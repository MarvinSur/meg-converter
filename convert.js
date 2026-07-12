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
    // Replace folder separators with underscores
    const safeName = relativePath.split(path.sep).join('_');
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
        // Evaluate the plugin code in the browser context
        const script = document.createElement('script');
        script.textContent = code;
        document.body.appendChild(script);
    }, pluginCode);

    // Wait a bit for plugin to initialize
    await new Promise(r => setTimeout(r, 2000));

    console.log("Loading .bbmodel files into Blockbench (one by one)...");
    for (const f of flatFiles) {
        console.log(`Injecting ${f.name}...`);
        const buffer = fs.readFileSync(f.path);
        const b64 = buffer.toString('base64');
        
        await page.evaluate(async (name, b64Data) => {
            const res = await fetch(`data:application/octet-stream;base64,${b64Data}`);
            const buf = await res.arrayBuffer();
            
            await new Promise((resolve) => {
                Blockbench.read([{
                    name: name,
                    content: buf,
                    path: name
                }], {name: name}, (results) => {
                    resolve();
                });
            });
        }, f.name, b64);
        
        // Small delay to ensure it's loaded in UI
        await new Promise(r => setTimeout(r, 500));
    }

    console.log("Triggering Export All...");
    await page.evaluate(() => {
        if (typeof export_all_action !== 'undefined') {
            export_all_action.click();
        } else {
            console.error("Plugin action not found!");
        }
    });

    console.log("Waiting for download to finish (unzip_it_to_input.zip)...");
    
    // Wait for the zip file to appear in DOWNLOADS_DIR
    let downloadedFilePath = null;
    let retries = 30; // 30 seconds timeout
    while (retries > 0) {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        // Wait for .zip and NOT .crdownload
        const zipFile = files.find(f => f.endsWith('.zip') && !f.endsWith('.crdownload'));
        if (zipFile) {
            downloadedFilePath = path.join(DOWNLOADS_DIR, zipFile);
            break;
        }
        await new Promise(r => setTimeout(r, 1000));
        retries--;
    }

    await browser.close();

    if (!downloadedFilePath) {
        console.error("Download failed or timed out.");
        process.exit(1);
    }

    console.log("=== 5. PACKAGING FINAL GEYSERMC ZIP ===");
    console.log(`Found downloaded export: ${downloadedFilePath}`);
    
    // The downloaded file is already a ZIP. 
    // It contains the folders for each model.
    // We will just rename and copy it to the root as Final_GeyserMC_Input.zip
    fs.copyFileSync(downloadedFilePath, FINAL_ZIP_PATH);
    console.log(`Success! Created ${FINAL_ZIP_PATH}`);
    
    // Optional cleanup
    cleanDir(WORK_DIR);
    console.log("Done.");
}

run().catch(console.error);
