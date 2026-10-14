import { describe, expect, test } from 'claude-code/testing';
import { TOOLS, changeRequest, claudeHome, isModHooks, joinPath, parentOf, readInstalled, readManifest } from '../hooks/tools';
const PLUGIN = 'roberts-toolbox';
const PANE = 'roberts-toolbox';
const COMMANDS = [
    { name: 'config', description: 'Open settings', source: 'builtin' },
    { name: 'plugin', description: 'Manage plugins', source: 'builtin' },
    { name: 'statusline', description: 'Status line', source: 'builtin' },
    { name: 'skins:skin-designer', description: 'Design a skin', source: 'plugin', plugin: 'skins' },
    { name: 'challenge', description: 'Daily challenge', source: 'plugin', plugin: 'daily-challenge' },
    { name: 'toolbox', description: 'Toolbox', source: 'plugin', plugin: 'roberts-toolbox' },
];
function dir(name) {
    return { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false };
}
const FILES = {
    'daily-challenge': JSON.stringify({ name: 'daily-challenge', description: 'One small exercise a day.' }),
    'roberts-toolbox': JSON.stringify({ name: 'roberts-toolbox', description: 'This one.' }),
    'quiet-mod': JSON.stringify({ name: 'quiet-mod', description: 'Has no command.' }),
};
/** Installed from marketplaces: one mod, one skill-only plugin, one turned off, one also in the mods folder. */
const INSTALLED = JSON.stringify({
    version: 2,
    plugins: {
        'skins@hellosverre-mods': [{ installPath: '/cache/hellosverre-mods/skins/1.0.0' }],
        'superpowers@claude-plugins-official': [{ installPath: '/cache/official/superpowers/5.0.6' }],
        'cache-tax@claude-code-mods': [{ installPath: '/cache/claude-code-mods/cache-tax/0.2.0' }],
        'daily-challenge@somewhere': [{ installPath: '/cache/somewhere/daily-challenge/1.0.0' }],
    },
});
const SETTINGS = JSON.stringify({ enabledPlugins: { 'cache-tax@claude-code-mods': false } });
const INSTALLED_FILES = {
    '/cache/hellosverre-mods/skins/1.0.0/hooks/hooks.json': '{"modules":["./register.tsx"]}',
    '/cache/hellosverre-mods/skins/1.0.0/.claude-plugin/plugin.json': '{"name":"skins","description":"Transcript skins."}',
    '/cache/official/superpowers/5.0.6/hooks/hooks.json': '{"hooks":{}}',
    '/cache/claude-code-mods/cache-tax/0.2.0/hooks/hooks.json': '{"modules":["./register.ts"]}',
    '/cache/somewhere/daily-challenge/1.0.0/hooks/hooks.json': '{"modules":["./register.ts"]}',
};
/** Stands in for the engine beneath the mod. */
function engine(on, mods = ['daily-challenge', 'roberts-toolbox', 'quiet-mod', 'not-a-mod']) {
    const seen = { ran: [], filled: [], closed: [], opened: [], listed: [] };
    const state = { mods };
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('command.list', () => ({ value: COMMANDS }));
    on('fs.list', ($, e) => {
        seen.listed.push(e.path ?? '');
        return { value: state.mods.map(dir) };
    });
    on('fs.read', ($, e) => {
        const path = e.path.replace(/\\/g, '/');
        if (path.endsWith('/.claude/plugins/installed_plugins.json'))
            return { value: INSTALLED };
        if (path.endsWith('/.claude/settings.json'))
            return { value: SETTINGS };
        // On Windows the engine hands the hook `/cache/...` with a drive letter in front.
        const installedFile = Object.keys(INSTALLED_FILES).find(key => path.endsWith(key));
        if (installedFile !== undefined)
            return { value: INSTALLED_FILES[installedFile] };
        const name = Object.keys(FILES).find(key => e.path.replace(/\\/g, '/').includes(`/${key}/.claude-plugin/plugin.json`));
        return name === undefined ? { deny: 'missing' } : { value: FILES[name] };
    });
    on('command.run', ($, e) => {
        seen.ran.push(e.command);
        return { text: '' };
    });
    on('prompt.fill', ($, e) => {
        seen.filled.push(e.text);
        return { isFilled: true };
    });
    on('ui.close', ($, e) => {
        seen.closed.push(e.id);
        return { value: undefined };
    });
    on('ui.open', ($, e) => {
        seen.opened.push(e.id);
        return { value: { isPlaced: true } };
    });
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
        const { Text } = $.ui.resolve(e);
        return <Text>{e.props.hint}</Text>;
    });
    return { seen, state };
}
async function start($) {
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true });
}
function paneProps(bodyColumns) {
    return { title: "Robert's Toolbox", isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} };
}
async function mountPane($, surface, columns) {
    return $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        requestId: PANE,
        props: paneProps(columns),
        viewport: { columns, rows: 80, isFullscreen: true },
    });
}
async function openFromCommand($) {
    return $.command.run({
        command: 'toolbox',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 120 },
    });
}
describe('helpers', () => {
    test('finds the mods folder from this mod folder on Windows and elsewhere', () => {
        expect(parentOf('C:\\Users\\r\\.claude\\dev-mods\\abc\\roberts-toolbox')).toBe('C:\\Users\\r\\.claude\\dev-mods\\abc');
        expect(parentOf('/home/r/mods/roberts-toolbox/')).toBe('/home/r/mods');
        expect(joinPath('C:\\mods', 'a', '.claude-plugin')).toBe('C:\\mods\\a\\.claude-plugin');
        expect(joinPath('/mods', 'a')).toBe('/mods/a');
    });
    test('reads a manifest and refuses what is not one', () => {
        expect(readManifest('{"name":"x","description":"y"}')).toEqual({ name: 'x', description: 'y' });
        expect(readManifest('{"description":"y"}')).toBeUndefined();
        expect(readManifest('not json')).toBeUndefined();
    });
    test('finds the .claude folder above this mod', () => {
        expect(claudeHome('C:\\Users\\r\\.claude\\dev-mods\\abc\\roberts-toolbox')).toBe('C:\\Users\\r\\.claude');
        expect(claudeHome('/home/r/.claude/plugins/cache/m/roberts-toolbox/0.1.0')).toBe('/home/r/.claude');
        expect(claudeHome('/somewhere/else/roberts-toolbox')).toBeUndefined();
    });
    test('reads installed plugins, leaving out the ones turned off', () => {
        expect(readInstalled(INSTALLED, SETTINGS).map(one => one.name)).toEqual(['skins', 'superpowers', 'daily-challenge']);
        expect(readInstalled(INSTALLED, SETTINGS)[0]).toEqual({ name: 'skins', marketplace: 'hellosverre-mods', folder: '/cache/hellosverre-mods/skins/1.0.0' });
        expect(readInstalled('not json')).toEqual([]);
    });
    test('a plugin is a mod when its hooks.json loads modules', () => {
        expect(isModHooks('{"modules":["./register.tsx"]}')).toBe(true);
        expect(isModHooks('{"hooks":{}}')).toBe(false);
        expect(isModHooks('{"modules":[]}')).toBe(false);
    });
    test('every tool has a unique key', () => {
        expect(new Set(TOOLS.map(tool => tool.key)).size).toBe(TOOLS.length);
    });
});
describe('the toolbox pane', () => {
    test('lists the other mods, and only the tools this version has', async ($, on) => {
        engine(on);
        await start($);
        for (const surface of ['terminal', 'desktop']) {
            const ui = await mountPane($, surface, 100);
            expect(await ui.find({ text: "ROBERT'S TOOLBOX" })).toBeDefined();
            expect(await ui.find({ text: 'daily-challenge' })).toBeDefined();
            expect(await ui.find({ text: 'quiet-mod' })).toBeDefined();
            expect(await ui.find({ text: 'This one.' })).toBeUndefined();
            expect(await ui.find({ type: 'Button', key: 'open-daily-challenge' })).toBeDefined();
            expect(await ui.find({ type: 'Button', key: 'open-quiet-mod' })).toBeUndefined();
            expect(await ui.find({ type: 'Button', key: 'change-quiet-mod' })).toBeDefined();
            expect(await ui.find({ type: 'Button', key: 'tool-config' })).toBeDefined();
            expect(await ui.find({ type: 'Button', key: 'tool-skin-designer' })).toBeDefined();
            expect(await ui.find({ type: 'Button', key: 'tool-hooks' })).toBeUndefined();
            await ui.unmount();
        }
    });
    test('lists installed mods apart from yours, and only the real mods', async ($, on) => {
        engine(on);
        await start($);
        for (const surface of ['terminal', 'desktop']) {
            const ui = await mountPane($, surface, 100);
            expect(await ui.find({ text: 'INSTALLED MODS' })).toBeDefined();
            expect(await ui.find({ text: 'skins' })).toBeDefined();
            expect(await ui.find({ text: 'Transcript skins.' })).toBeDefined();
            expect(await ui.find({ type: 'Button', key: 'open-skins' })).toBeDefined();
            expect(await ui.find({ type: 'Button', key: 'change-skins' })).toBeDefined();
            expect(await ui.find({ text: 'superpowers' })).toBeUndefined();
            expect(await ui.find({ text: 'cache-tax' })).toBeUndefined();
            expect(await ui.findAll({ type: 'Button', key: 'change-daily-challenge' })).toHaveLength(1);
            await ui.unmount();
        }
    });
    test('change on an installed mod asks for a copy in the mods folder', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        await ui.press({ key: 'change-skins' });
        expect(seen.filled[0]).toStartWith('Change my installed skins mod (from the hellosverre-mods marketplace');
        expect(seen.filled[0]).toContain('make the change as my own copy in my mods folder');
    });
    test('the callout shows installed mods too', async ($, on) => {
        engine(on);
        await start($);
        const ui = await mountHint($, true);
        await ui.press({ key: 'open-toolbox' });
        expect(await ui.find({ text: 'INSTALLED MODS' })).toBeDefined();
        expect(await ui.find({ type: 'Button', key: 'change-skins' })).toBeDefined();
    });
    test('open runs the mod command and closes the toolbox', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        await ui.press({ key: 'open-daily-challenge' });
        expect(seen.closed).toContain(PANE);
        expect(seen.ran).toContain('challenge');
    });
    test('change fills a request to change that mod', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        await ui.press({ key: 'change-daily-challenge' });
        expect(seen.closed).toContain(PANE);
        expect(seen.filled[0]).toStartWith('Change my daily-challenge mod (its folder is ');
        expect(seen.filled[0]).toContain('daily-challenge');
        expect(changeRequest({ name: 'x', description: '', folder: 'F', commands: [], kind: 'dev' })).toBe('Change my x mod (its folder is F): ');
    });
    test('new mod fills a request to make one', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        await ui.press({ key: 'new-mod' });
        expect(seen.filled).toEqual(['Design and make me a new mod: ']);
    });
    test('a run tool runs, and a fill tool waits in the prompt box', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        await ui.press({ key: 'tool-config' });
        expect(seen.ran).toContain('config');
        await ui.unmount();
        const again = await mountPane($, 'terminal', 100);
        await again.press({ key: 'tool-skin-designer' });
        expect(seen.filled).toContain('/skins:skin-designer ');
        expect(seen.ran).not.toContain('skins:skin-designer');
    });
    test('refresh picks up a new mod', async ($, on) => {
        const { state } = engine(on, ['daily-challenge']);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        expect(await ui.find({ text: 'quiet-mod' })).toBeUndefined();
        state.mods = ['daily-challenge', 'quiet-mod'];
        await ui.press({ key: 'refresh' });
        expect(await ui.find({ text: 'quiet-mod' })).toBeDefined();
    });
    test('says so when there are no other mods', async ($, on) => {
        engine(on, ['roberts-toolbox']);
        await start($);
        const ui = await mountPane($, 'terminal', 100);
        expect(await ui.find({ text: 'No other mods in your mods folder yet.' })).toBeDefined();
        expect(await ui.find({ type: 'Button', key: 'new-mod' })).toBeDefined();
    });
    test('every row fits at a narrow and a wide width', async ($, on) => {
        engine(on);
        await start($);
        for (const columns of [24, 36, 60, 140]) {
            const ui = await mountPane($, 'terminal', columns);
            for (const text of await ui.findAll({ type: 'Text' })) {
                for (const line of text.text.split('\n')) {
                    expect(line.length <= columns, `${columns} cols: "${line}" is ${line.length}`).toBe(true);
                }
            }
            await ui.unmount();
        }
    });
});
describe('opening it', () => {
    test('/toolbox answers at once', async ($, on) => {
        engine(on);
        await start($);
        const result = await openFromCommand($);
        expect(result.text).toBe("Opening Robert's Toolbox.");
    });
    test("the Robert's Toolbox button sits at the right end of the hint line", async ($, on) => {
        engine(on);
        await start($);
        const ui = await mountHint($, true);
        expect(await ui.find({ text: "Robert's Toolbox" })).toBeDefined();
        expect(await ui.find({ text: "ROBERT'S TOOLBOX" })).toBeUndefined();
    });
    test('a click opens the callout above the button, and a second click closes it', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountHint($, true);
        await ui.press({ key: 'open-toolbox' });
        expect(seen.opened).not.toContain(PANE);
        expect(await ui.find({ text: "ROBERT'S TOOLBOX" })).toBeDefined();
        expect(await ui.find({ text: 'daily-challenge' })).toBeDefined();
        expect(await ui.find({ type: 'Button', key: 'tool-config' })).toBeDefined();
        await ui.press({ key: 'open-toolbox' });
        expect(await ui.find({ text: "ROBERT'S TOOLBOX" })).toBeUndefined();
    });
    test('a pick in the callout runs it and closes the callout', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountHint($, true);
        await ui.press({ key: 'open-toolbox' });
        await ui.press({ key: 'open-daily-challenge' });
        expect(seen.ran).toContain('challenge');
        expect(await ui.find({ text: "ROBERT'S TOOLBOX" })).toBeUndefined();
    });
    test('every callout row fits inside the callout', async ($, on) => {
        engine(on);
        await start($);
        for (const columns of [40, 80, 160]) {
            const ui = await mountHint($, true, columns);
            await ui.press({ key: 'open-toolbox' });
            const inner = Math.max(24, Math.min(60, columns - 2)) - 4;
            for (const text of await ui.findAll({ type: 'Text' })) {
                if (text.text.includes('? for shortcuts'))
                    continue;
                for (const line of text.text.split('\n')) {
                    expect(line.length <= inner, `${columns} cols: "${line}" is ${line.length}`).toBe(true);
                }
            }
            await ui.press({ key: 'open-toolbox' });
            await ui.unmount();
        }
    });
    test('off the fullscreen layout the button opens the pane instead', async ($, on) => {
        const { seen } = engine(on);
        await start($);
        const ui = await mountHint($, false);
        await ui.press({ key: 'open-toolbox' });
        expect(seen.opened).toContain(PANE);
    });
});
async function mountHint($, isFullscreen, columns = 100) {
    return $.ui.mount({
        plugin: PLUGIN,
        surface: 'terminal',
        component: 'PromptHint',
        props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
        viewport: { columns, rows: 40, isFullscreen },
    });
}
