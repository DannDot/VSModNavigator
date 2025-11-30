import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as jsonc from 'jsonc-parser';
import { downloadMod } from './modDownloader';

export function activate(context: vscode.ExtensionContext) {
    console.log('VSModNavigator is now active!');

    // Register Download Command
    context.subscriptions.push(vscode.commands.registerCommand('vs-mod-navigator.downloadMod', async (modId?: string) => {
        if (!modId) {
            modId = await vscode.window.showInputBox({
                prompt: 'Enter Mod ID (e.g. rustboundmagic)',
                placeHolder: 'rustboundmagic'
            });
        }

        if (modId) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            await downloadMod(modId, workspaceFolder);
        }
    }));

    // Register Hover Provider for missing mods
    context.subscriptions.push(vscode.languages.registerHoverProvider(
        { scheme: 'file', language: 'json' },
        {
            async provideHover(document, position, token) {
                const text = document.getText();
                const tree = jsonc.parseTree(text);
                if (!tree) return undefined;

                const offset = document.offsetAt(position);
                const node = jsonc.findNodeAtOffset(tree, offset);

                if (!node || node.type !== 'string') return undefined;

                // Check if it's a value of "file" or "path" property, OR just a string that looks like a path
                // The user might hover over "rustboundmagic:..." anywhere.
                // But let's be safe and check if it looks like a VS path.
                const value = node.value;
                if (typeof value === 'string' && value.includes(':')) {
                    const parts = value.split(':');
                    if (parts.length === 2) {
                        const domain = parts[0];
                        // Check if domain exists
                        const exists = await checkDomainExists(domain);
                        if (!exists) {
                            const args = encodeURIComponent(JSON.stringify([domain]));
                            const md = new vscode.MarkdownString(`Mod '${domain}' not found in workspace. \n\n[Download Mod](command:vs-mod-navigator.downloadMod?${args})`);
                            md.isTrusted = true;
                            return new vscode.Hover(md);
                        }
                    }
                }
                return undefined;
            }
        }
    ));

    const provider = vscode.languages.registerDefinitionProvider(
        { scheme: 'file', language: 'json' },
        {
            provideDefinition(document, position, token) {
                return provideDefinition(document, position);
            }
        }
    );

    context.subscriptions.push(provider);
}

async function provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | undefined> {
    try {
        const text = document.getText();
        const tree = jsonc.parseTree(text);
        if (!tree) {
            return undefined;
        }

        const offset = document.offsetAt(position);
        const node = jsonc.findNodeAtOffset(tree, offset);

        if (!node || node.type !== 'string') {
            return undefined;
        }

        // Check if we are in a property value
        if (node.parent?.type !== 'property') {
            return undefined;
        }

        const keyNode = node.parent.children?.[0];
        if (!keyNode || keyNode.type !== 'string') {
            return undefined;
        }

        const key = keyNode.value;
        
        // Get the value node of the property to ensure we use the value even if the user clicked the key
        const valueNode = node.parent.children?.[1];
        if (!valueNode || valueNode.type !== 'string') {
            return undefined;
        }
        const value = valueNode.value;

        console.log(`VSModNavigator: Found key="${key}", value="${value}"`);

        if (key === 'file') {
            return await resolveFileDefinition(value);
        } else if (key === 'path') {
            return await resolvePathDefinition(valueNode, value);
        }

        return undefined;
    } catch (e) {
        console.error('VSModNavigator: Error in provideDefinition', e);
        return undefined;
    }
}

async function resolveFileDefinition(fileString: string): Promise<vscode.Location | undefined> {
    const targetUri = await resolveVintageStoryPath(fileString);
    if (targetUri) {
        console.log(`VSModNavigator: Resolved file to ${targetUri.fsPath}`);
        return new vscode.Location(targetUri, new vscode.Position(0, 0));
    }
    console.log(`VSModNavigator: Could not resolve file ${fileString}`);
    return undefined;
}

async function resolvePathDefinition(pathNode: jsonc.Node, jsonPointer: string): Promise<vscode.Location | undefined> {
    // 1. Find the sibling "file" property
    const parent = pathNode.parent?.parent; // The object containing "file" and "path"
    if (!parent || parent.type !== 'object') {
        return undefined;
    }

    const fileProperty = findProperty(parent, 'file');
    if (!fileProperty) {
        return undefined;
    }

    const fileValueNode = fileProperty.children?.[1];
    if (!fileValueNode || fileValueNode.type !== 'string') {
        return undefined;
    }

    const fileString = fileValueNode.value;
    const targetUri = await resolveVintageStoryPath(fileString);

    if (!targetUri) {
        return undefined;
    }

    // 2. Read the target file and find the path
    try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const text = doc.getText();
        const tree = jsonc.parseTree(text);
        
        if (!tree) {
            return new vscode.Location(targetUri, new vscode.Position(0, 0));
        }

        // 3. Resolve JSON pointer
        // JSON pointer /0/ingredients means: root -> index 0 -> key "ingredients"
        const pathParts = jsonPointer.split('/').filter(p => p.length > 0);
        let currentNode: jsonc.Node | undefined = tree;

        for (const part of pathParts) {
            if (!currentNode) break;

            if (currentNode.type === 'array') {
                const index = parseInt(part);
                if (!isNaN(index) && currentNode.children && index < currentNode.children.length) {
                    currentNode = currentNode.children[index];
                } else {
                    currentNode = undefined;
                }
            } else if (currentNode.type === 'object') {
                const property = findProperty(currentNode, part);
                if (property) {
                    currentNode = property.children?.[1]; // The value of the property
                    // If we want to point to the key, we could use property.children[0]
                    // But usually pointing to the value or the property start is fine.
                    // Let's point to the property key for better visibility
                    if (property.children?.[0]) {
                         currentNode = property.children[0];
                    }
                } else {
                    currentNode = undefined;
                }
            } else {
                currentNode = undefined;
            }
        }

        if (currentNode) {
            const startPos = doc.positionAt(currentNode.offset);
            const endPos = doc.positionAt(currentNode.offset + currentNode.length);
            return new vscode.Location(targetUri, new vscode.Range(startPos, endPos));
        } else {
            // Fallback to top of file if path not found
            return new vscode.Location(targetUri, new vscode.Position(0, 0));
        }

    } catch (e) {
        console.error("VSModNavigator: Error resolving path definition", e);
        return undefined;
    }
}

async function resolveVintageStoryPath(pathStr: string): Promise<vscode.Uri | undefined> {
    // Format: domain:path/to/file
    const parts = pathStr.split(':');
    if (parts.length !== 2) {
        return undefined;
    }

    const domain = parts[0];
    const relativePath = parts[1];

    if (!vscode.workspace.workspaceFolders) {
        return undefined;
    }

    // Helper to check if a folder name matches the domain (e.g. "rustboundmagic_3.1.7" matches "rustboundmagic")
    const isMatchingFolder = (name: string) => name === domain || name.startsWith(domain + '_') || name.startsWith(domain + '-');

    for (const folder of vscode.workspace.workspaceFolders) {
        // Strategy 1: Check if the workspace folder itself is the mod folder
        if (isMatchingFolder(folder.name)) {
             const potentialPath = path.join(folder.uri.fsPath, 'assets', domain, relativePath);
             if (fs.existsSync(potentialPath)) {
                 return vscode.Uri.file(potentialPath);
             }
        }

        // Strategy 2: Check subdirectories of the workspace folder
        try {
            const children = await vscode.workspace.fs.readDirectory(folder.uri);
            for (const [name, type] of children) {
                if (type === vscode.FileType.Directory && isMatchingFolder(name)) {
                    const potentialPath = path.join(folder.uri.fsPath, name, 'assets', domain, relativePath);
                    if (fs.existsSync(potentialPath)) {
                        return vscode.Uri.file(potentialPath);
                    }
                }
            }
        } catch (e) {
            console.error(`VSModNavigator: Error reading directory ${folder.uri.fsPath}`, e);
        }
    }

    return undefined;
}

async function checkDomainExists(domain: string): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders) {
        return false;
    }

    const isMatchingFolder = (name: string) => name === domain || name.startsWith(domain + '_') || name.startsWith(domain + '-');

    for (const folder of vscode.workspace.workspaceFolders) {
        if (isMatchingFolder(folder.name)) {
             // Check if it has assets/domain
             const assetsPath = path.join(folder.uri.fsPath, 'assets', domain);
             if (fs.existsSync(assetsPath)) return true;
        }

        // Check subdirectories
        try {
            const children = await vscode.workspace.fs.readDirectory(folder.uri);
            for (const [name, type] of children) {
                if (type === vscode.FileType.Directory && isMatchingFolder(name)) {
                    const assetsPath = path.join(folder.uri.fsPath, name, 'assets', domain);
                    if (fs.existsSync(assetsPath)) return true;
                }
            }
        } catch (e) {
            // Ignore errors reading directory
        }
    }
    return false;
}

function findProperty(node: jsonc.Node, key: string): jsonc.Node | undefined {
    if (node.type !== 'object' || !node.children) {
        return undefined;
    }
    for (const child of node.children) {
        if (child.type === 'property' && child.children && child.children.length > 0) {
            const keyNode = child.children[0];
            if (keyNode.value === key) {
                return child;
            }
        }
    }
    return undefined;
}

export function deactivate() {}
