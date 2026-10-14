import { atom, read, update } from 'claude-code';
import { NEW_MOD_REQUEST, changeRequest, claudeHome, fillText, isModHooks, joinPath, parentOf, readInstalled, readManifest, toolsIn, } from './tools';
const PANE = 'roberts-toolbox';
const PANE_TITLE = "Robert's Toolbox";
const BUTTON_LABEL = "Robert's Toolbox";
const TITLE = "ROBERT'S TOOLBOX";
const FAILED = "Robert's Toolbox could not do that just now. Please try again in a moment.";
/** The hover group the button and its callout share: the callout shows while the pointer is on either. */
const HOVER_SCOPE = 'roberts-toolbox-callout';
const CALLOUT_WIDTH = 60;
const COLORS = {
    gold: '#F2C46D',
    line: '#262B33',
    muted: '#7D8590',
    text: '#E6EDF3',
    green: '#3DD68C',
    ink: '#0D1117',
    panel: '#161B22',
};
const catalogAtom = atom({ plugin: 'roberts-toolbox', key: 'catalog' }, null);
const isOpenAtom = atom({ plugin: 'roberts-toolbox', key: 'isOpen' }, false);
function quietly(work) {
    work.catch(() => undefined);
}
function fit(text, width) {
    if (width <= 0)
        return '';
    if (text.length <= width)
        return text;
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
/**
 * Where Claude Code keeps its plugins: CLAUDE_CONFIG_DIR when set, else the `.claude`
 * folder this mod sits under, else `.claude` in the home folder (a mod installed from
 * a folder elsewhere, as from a local marketplace).
 */
async function findClaudeHome($) {
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined);
    if (configDir !== undefined && configDir !== '')
        return configDir;
    const fromRoot = claudeHome($.plugin.root);
    if (fromRoot !== undefined)
        return fromRoot;
    const home = (await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined));
    return home === undefined || home === '' ? undefined : joinPath(home, '.claude');
}
/** Looks at the mods folder and the session's commands. Never called while drawing. */
async function scan($) {
    const commands = await $.command.list().catch(() => []);
    const folder = parentOf($.plugin.root);
    const entries = await $.fs.list(folder).catch(() => []);
    const commandsOf = (name) => commands.filter(one => one.source === 'plugin' && one.plugin === name).map(one => one.name);
    const manifestIn = async (modFolder) => {
        const text = await $.fs.read(joinPath(modFolder, '.claude-plugin', 'plugin.json')).catch(() => undefined);
        return typeof text === 'string' ? readManifest(text) : undefined;
    };
    const mods = [];
    const seen = new Set([$.plugin.name]);
    for (const entry of entries) {
        if (entry.kind !== 'dir' || entry.name.startsWith('.'))
            continue;
        const modFolder = joinPath(folder, entry.name);
        const manifest = await manifestIn(modFolder);
        if (manifest === undefined || seen.has(manifest.name))
            continue;
        seen.add(manifest.name);
        mods.push({ ...manifest, folder: modFolder, commands: commandsOf(manifest.name), kind: 'dev' });
    }
    // Installed plugins count as mods when their hooks.json loads hooks modules; skill-only plugins do not.
    const home = await findClaudeHome($);
    if (home !== undefined) {
        const installedText = await $.fs.read(joinPath(home, 'plugins', 'installed_plugins.json')).catch(() => undefined);
        const settingsText = await $.fs.read(joinPath(home, 'settings.json')).catch(() => undefined);
        const installed = typeof installedText === 'string'
            ? readInstalled(installedText, typeof settingsText === 'string' ? settingsText : undefined)
            : [];
        for (const plugin of installed) {
            if (seen.has(plugin.name))
                continue;
            const hooks = await $.fs.read(joinPath(plugin.folder, 'hooks', 'hooks.json')).catch(() => undefined);
            if (typeof hooks !== 'string' || !isModHooks(hooks))
                continue;
            const manifest = await manifestIn(plugin.folder);
            seen.add(plugin.name);
            mods.push({
                name: plugin.name,
                description: manifest?.description ?? '',
                folder: plugin.folder,
                commands: commandsOf(plugin.name),
                kind: 'installed',
                marketplace: plugin.marketplace,
            });
        }
    }
    mods.sort((a, b) => a.name.localeCompare(b.name));
    return { mods, available: commands.map(one => one.name) };
}
async function refresh($) {
    const catalog = await scan($);
    await update($, catalogAtom, () => catalog);
    return catalog;
}
async function openToolbox($) {
    await refresh($).catch(() => undefined);
    await $.ui.open({ id: PANE, title: PANE_TITLE });
}
async function toggleCallout($) {
    const isOpen = await update($, isOpenAtom, was => !was);
    if (isOpen)
        await refresh($).catch(() => undefined);
}
/** Closes the toolbox, wherever it shows, then hands over to what was picked. */
async function leaveFor($, then) {
    await update($, isOpenAtom, () => false);
    await $.ui.close({ id: PANE }).catch(() => undefined);
    await then();
}
const runCommand = ($, command) => leaveFor($, () => $.command.run({ command }));
const fillPrompt = ($, text) => leaveFor($, () => $.prompt.fill({ text }));
function useTool($, tool) {
    return tool.action === 'run' ? runCommand($, tool.command) : fillPrompt($, fillText(tool));
}
export const register = on => {
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'toolbox',
            description: "Open Robert's Toolbox: your mods and the commands that change Claude Code",
        });
        await update($, isOpenAtom, () => false);
        quietly(refresh($));
        return next(e);
    });
    on('command.run', { command: 'toolbox' }, async ($) => {
        try {
            quietly(openToolbox($));
            return { text: "Opening Robert's Toolbox." };
        }
        catch {
            return { text: FAILED };
        }
    }).catch(() => ({ text: FAILED }));
    on('prompt.submit', async ($, e, next) => {
        quietly(update($, isOpenAtom, () => false));
        return next(e);
    });
    /** The button at the right end of the hint line, and above it, once clicked, the callout. */
    on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
        const engine = await next(e);
        const { Box, Button, Text } = $.ui.resolve(e);
        // Off the fullscreen layout the hint line clips anything drawn above it, so the button opens the pane.
        const isCallout = e.viewport?.isFullscreen !== false;
        const isOpen = isCallout && (await read($, isOpenAtom));
        const catalog = isOpen ? await read($, catalogAtom) : null;
        const columns = e.viewport?.columns ?? 80;
        const width = Math.max(24, Math.min(CALLOUT_WIDTH, columns - 2));
        const cols = width - 4;
        const maxRows = Math.max(6, (e.viewport?.rows ?? 40) - 6);
        const chip = (key, label, isMain, onPress) => (<Button key={key} plain onPress={() => quietly(onPress())}>
        <Text backgroundColor={isMain ? COLORS.gold : COLORS.line} color={isMain ? COLORS.ink : COLORS.text} bold={isMain}>
          {` ${label} `}
        </Text>
      </Button>);
        const heading = (label) => {
            const text = fit(label.toUpperCase(), cols);
            const rest = cols - text.length - 1;
            return (<Text wrap="truncate">
          <Text color={COLORS.muted} bold>{text}</Text>
          <Text color={COLORS.line}>{rest > 0 ? ` ${'─'.repeat(rest)}` : ''}</Text>
        </Text>);
        };
        const toolRow = (tool, labelWidth) => {
            const room = cols - labelWidth - 1;
            return (<Button key={`tool-${tool.key}`} plain onPress={() => quietly(useTool($, tool))}>
          <Text backgroundColor={COLORS.line} color={COLORS.text}>{` ${fit(`/${tool.command}`, cols - 2)} `.padEnd(Math.min(labelWidth, cols))}</Text>
          {room >= 8 && <Text color={COLORS.muted}>{` ${fit(tool.description, room)}`}</Text>}
        </Button>);
        };
        const calloutBody = () => {
            if (catalog === null)
                return [<Text key="loading" color={COLORS.muted}>{fit('Looking for your mods…', cols)}</Text>];
            const modRow = (mod) => {
                const hasOpen = mod.commands.length > 0;
                const nameRoom = cols - ((hasOpen ? 7 : 0) + 8) - 1;
                return (<Box key={`mod-${mod.name}`} flexDirection="row" justifyContent="space-between" width={cols}>
            <Text bold color={COLORS.text}>{fit(mod.name, nameRoom)}</Text>
            <Box flexDirection="row" columnGap={1}>
              {hasOpen && chip(`open-${mod.name}`, 'Open', false, () => runCommand($, mod.commands[0] ?? ''))}
              {chip(`change-${mod.name}`, 'Change', false, () => fillPrompt($, changeRequest(mod)))}
            </Box>
          </Box>);
            };
            const own = catalog.mods.filter(mod => mod.kind === 'dev');
            const installed = catalog.mods.filter(mod => mod.kind === 'installed');
            const rows = [heading('Your mods')];
            if (own.length === 0)
                rows.push(<Text key="no-mods" color={COLORS.muted}>{fit('No other mods yet.', cols)}</Text>);
            for (const mod of own)
                rows.push(modRow(mod));
            rows.push(chip('new-mod', 'New mod', true, () => fillPrompt($, NEW_MOD_REQUEST)));
            // The callout keeps to the rows above the prompt: installed mods, then tools, take what is left.
            const installedRoom = maxRows - 4 - rows.length - 1;
            if (installed.length > 0 && installedRoom >= 1) {
                rows.push(heading('Installed mods'));
                for (const mod of installed.slice(0, installedRoom))
                    rows.push(modRow(mod));
            }
            // Each tool takes one row; what would not fit is dropped.
            const sections = [
                { label: 'Change Claude Code', tools: toolsIn('claude', catalog) },
                { label: 'Plugin tools', tools: toolsIn('plugins', catalog) },
            ];
            const all = sections.flatMap(section => section.tools);
            const labelWidth = all.length === 0 ? 0 : Math.max(...all.map(tool => tool.command.length + 1)) + 2;
            for (const section of sections) {
                const room = maxRows - 4 - rows.length - 1;
                if (section.tools.length === 0 || room < 1)
                    continue;
                rows.push(heading(section.label));
                for (const tool of section.tools.slice(0, room))
                    rows.push(toolRow(tool, labelWidth));
            }
            return rows;
        };
        const callout = isOpen && (<Box position="absolute" bottom={1} right={0} width={width} flexDirection="column" borderStyle="round" borderColor={COLORS.gold} backgroundColor={COLORS.panel} paddingX={1} display="none" hover={{ scope: HOVER_SCOPE, display: 'flex' }}>
        <Text bold color={COLORS.gold}>{fit(TITLE, cols)}</Text>
        {calloutBody()}
      </Box>);
        // The engine's own line may not sit under a sized Box (the terminal refuses the tree
        // and draws its own), so it is a direct child and space-between pushes the button right.
        return (<Box flexDirection="row" justifyContent="space-between">
        {engine}
        <Box key="toolbox-anchor" flexShrink={0} hover={{ scope: HOVER_SCOPE }}>
          <Button key="open-toolbox" plain onPress={() => quietly(isCallout ? toggleCallout($) : openToolbox($))}>
            <Text color={COLORS.gold} bold={isOpen}>{BUTTON_LABEL}</Text>
          </Button>
          {callout}
        </Box>
      </Box>);
    });
    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
        const { Box, Button, Text } = $.ui.resolve(e);
        const catalog = await read($, catalogAtom);
        const cols = Math.max(20, Math.floor(e.props.bodyColumns));
        const headingRow = (label) => {
            const text = fit(label.toUpperCase(), cols);
            const rest = cols - text.length - 1;
            return (<Box marginTop={1}>
          <Text wrap="truncate">
            <Text color={COLORS.muted} bold>{text}</Text>
            <Text color={COLORS.line}>{rest > 0 ? ` ${'─'.repeat(rest)}` : ''}</Text>
          </Text>
        </Box>);
        };
        const chip = (key, label, isMain, onPress) => (<Button key={key} plain onPress={() => quietly(onPress())}>
        <Text backgroundColor={isMain ? COLORS.gold : COLORS.line} color={isMain ? COLORS.ink : COLORS.text} bold={isMain}>
          {` ${label} `}
        </Text>
      </Button>);
        const header = (<Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text bold color={COLORS.text}>{fit(TITLE, cols)}</Text>
          {catalog !== null && TITLE.length + 10 <= cols && (<Text color={COLORS.muted}>{`${catalog.mods.length} ${catalog.mods.length === 1 ? 'mod' : 'mods'}`}</Text>)}
        </Box>
        <Text wrap="truncate">
          <Text color={COLORS.gold}>{'━'.repeat(Math.min(TITLE.length, cols))}</Text>
          <Text color={COLORS.line}>{'─'.repeat(Math.max(0, cols - TITLE.length))}</Text>
        </Text>
      </Box>);
        if (catalog === null) {
            return (<Box flexDirection="column" width={cols}>
          {header}
          <Text color={COLORS.muted}>{fit('Looking for your mods…', cols)}</Text>
        </Box>);
        }
        const toolRows = (tools) => {
            const labelWidth = Math.max(...tools.map(tool => tool.command.length + 1)) + 2;
            return tools.map(tool => {
                const label = `/${tool.command}`;
                const room = cols - labelWidth - 1;
                return (<Button key={`tool-${tool.key}`} plain onPress={() => quietly(useTool($, tool))}>
            <Text backgroundColor={COLORS.line} color={COLORS.text}>{` ${fit(label, cols - 2)} `.padEnd(Math.min(labelWidth, cols))}</Text>
            {room >= 8 && <Text color={COLORS.muted}>{` ${fit(tool.description, room)}`}</Text>}
          </Button>);
            });
        };
        const modBlock = (mod) => {
            const hasOpen = mod.commands.length > 0;
            const buttonsWidth = (hasOpen ? 7 : 0) + 8;
            const isStacked = cols - buttonsWidth - 1 < 12;
            const nameRoom = isStacked ? cols : cols - buttonsWidth - 1;
            const buttons = (<Box flexDirection="row" columnGap={1}>
          {hasOpen && chip(`open-${mod.name}`, 'Open', false, () => runCommand($, mod.commands[0] ?? ''))}
          {chip(`change-${mod.name}`, 'Change', false, () => fillPrompt($, changeRequest(mod)))}
        </Box>);
            return (<Box key={`mod-${mod.name}`} flexDirection="column" width={cols}>
          <Box flexDirection="row" justifyContent="space-between" width={cols}>
            <Text bold color={COLORS.text}>{fit(mod.name, nameRoom)}</Text>
            {!isStacked && buttons}
          </Box>
          {mod.description !== '' && <Text color={COLORS.muted}>{fit(mod.description, cols)}</Text>}
          {hasOpen && <Text color={COLORS.muted}>{fit(mod.commands.map(name => `/${name}`).join('  '), cols)}</Text>}
          {isStacked && buttons}
        </Box>);
        };
        const own = catalog.mods.filter(mod => mod.kind === 'dev');
        const installed = catalog.mods.filter(mod => mod.kind === 'installed');
        const claudeTools = toolsIn('claude', catalog);
        const pluginTools = toolsIn('plugins', catalog);
        return (<Box flexDirection="column" width={cols}>
        {header}

        {headingRow('Your mods')}
        {own.length === 0 && <Text color={COLORS.muted}>{fit('No other mods in your mods folder yet.', cols)}</Text>}
        {own.map(modBlock)}
        <Box marginTop={1}>{chip('new-mod', 'New mod', true, () => fillPrompt($, NEW_MOD_REQUEST))}</Box>

        {installed.length > 0 && headingRow('Installed mods')}
        {installed.map(modBlock)}

        {claudeTools.length > 0 && headingRow('Change Claude Code')}
        {claudeTools.length > 0 && <Box flexDirection="column">{toolRows(claudeTools)}</Box>}

        {pluginTools.length > 0 && headingRow('Plugin tools')}
        {pluginTools.length > 0 && <Box flexDirection="column">{toolRows(pluginTools)}</Box>}

        <Box marginTop={1} flexDirection="row" columnGap={2}>
          <Button key="refresh" plain dimColor onPress={() => quietly(refresh($))}>
            <Text color={COLORS.muted}>Refresh</Text>
          </Button>
          {cols >= 40 && <Text color={COLORS.muted}>{fit('Opens commands as if you typed them.', cols - 10)}</Text>}
        </Box>
      </Box>);
    });
};
