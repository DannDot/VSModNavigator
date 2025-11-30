import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as AdmZip from 'adm-zip';
import { exec } from 'child_process';
import * as os from 'os';

const API_BASE_URL = 'https://mods.vintagestory.at/api/mod/';

export async function downloadMod(modId: string, workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    try {
        console.log(`[VSModNavigator] Starting download for mod: ${modId}`);
        // 1. Get Mod Info
        const modInfo = await fetchModInfo(modId);
        console.log(`[VSModNavigator] Mod Info received. Keys: ${Object.keys(modInfo || {}).join(', ')}`);
        if (modInfo && modInfo.mod) {
             console.log(`[VSModNavigator] modInfo.mod keys: ${Object.keys(modInfo.mod).join(', ')}`);
             console.log(`[VSModNavigator] modInfo.mod.releases: ${modInfo.mod.releases ? 'Present' : 'Missing'}`);
        }

        // Check for releases inside mod object
        const releases = modInfo?.mod?.releases;

        if (!modInfo || !modInfo.mod || !releases || !Array.isArray(releases) || releases.length === 0) {
            console.error(`[VSModNavigator] Invalid mod info structure.`);
            vscode.window.showErrorMessage(`Mod '${modId}' not found or has no releases.`);
            return false;
        }

        const latestRelease = releases[0];
        const downloadUrl = latestRelease.mainfile;
        const fileName = latestRelease.filename;

        if (!downloadUrl) {
            console.error(`[VSModNavigator] No download URL in release.`);
            vscode.window.showErrorMessage(`No download URL found for mod '${modId}'.`);
            return false;
        }

        console.log(`[VSModNavigator] Download URL: ${downloadUrl}`);

        // 2. Download File
        const downloadPath = path.join(workspaceFolder.uri.fsPath, fileName);
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading ${modInfo.mod.name || modId}...`,
            cancellable: false
        }, async (progress) => {
            await downloadFile(downloadUrl, downloadPath);
        });

        // 3. Unzip
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Unzipping ${fileName}...`,
            cancellable: false
        }, async (progress) => {
            const zip = new AdmZip(downloadPath);
            const extractFolderName = path.basename(fileName, '.zip'); // e.g. rustboundmagic_3.1.8
            const extractPath = path.join(workspaceFolder.uri.fsPath, extractFolderName);
            
            if (!fs.existsSync(extractPath)) {
                fs.mkdirSync(extractPath);
            }
            
            zip.extractAllTo(extractPath, true);
        });

        // 4. Cleanup Zip
        fs.unlinkSync(downloadPath);

        vscode.window.showInformationMessage(`Successfully downloaded and installed ${modInfo.mod.name || modId}.`);
        return true;

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to download mod '${modId}': ${error.message}`);
        console.error(`[VSModNavigator] Error:`, error);
        return false;
    }
}

async function fetchModInfo(modId: string): Promise<any> {
    return fetchJson(`${API_BASE_URL}${modId}`);
}

async function fetchJson(url: string): Promise<any> {
    console.log(`[VSModNavigator] Fetching URL using curl: ${url}`);
    return new Promise((resolve, reject) => {
        const tempFile = path.join(os.tmpdir(), `vsmod_info_${Date.now()}.json`);
        // Use curl.exe on Windows to bypass PowerShell alias
        // Added --http1.1 and --ssl-no-revoke just in case
        const command = process.platform === 'win32' 
            ? `curl.exe -v --http1.1 --ssl-no-revoke -s -o "${tempFile}" "${url}"` 
            : `curl -v --http1.1 -s -o "${tempFile}" "${url}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[VSModNavigator] Curl error: ${error.message}`);
                reject(error);
                return;
            }

            if (fs.existsSync(tempFile)) {
                try {
                    const fileContent = fs.readFileSync(tempFile, 'utf8');
                    const data = JSON.parse(fileContent);
                    
                    // Cleanup
                    try { fs.unlinkSync(tempFile); } catch (e) {}
                    
                    resolve(data);
                } catch (e: any) {
                    console.error('[VSModNavigator] JSON Parse Error:', e.message);
                    // Try to read a bit of the file to debug
                    try {
                        const content = fs.readFileSync(tempFile, 'utf8');
                        console.log('[VSModNavigator] File content snippet:', content.substring(0, 200));
                    } catch (readErr) {}
                    
                    reject(e);
                }
            } else {
                reject(new Error('Output file was not created by curl.'));
            }
        });
    });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
    console.log(`[VSModNavigator] Downloading file using curl: ${url}`);
    return new Promise((resolve, reject) => {
        // Use curl.exe on Windows to bypass PowerShell alias
        // Added -L to follow redirects automatically
        const command = process.platform === 'win32' 
            ? `curl.exe -L -v --http1.1 --ssl-no-revoke -o "${destPath}" "${url}"` 
            : `curl -L -v --http1.1 -o "${destPath}" "${url}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[VSModNavigator] Curl download error: ${error.message}`);
                // Cleanup partial file
                if (fs.existsSync(destPath)) {
                    try { fs.unlinkSync(destPath); } catch (e) {}
                }
                reject(error);
                return;
            }
            
            if (fs.existsSync(destPath)) {
                resolve();
            } else {
                reject(new Error('Download file was not created by curl.'));
            }
        });
    });
}
