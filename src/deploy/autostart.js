/**
 * Task Scheduler autostart.
 *
 * DESIGN 11 prefers a scheduled task over the `Run` registry key for one concrete
 * reason: `HKCU\...\Run` re-launches the app after a reboot but not after a crash
 * loop, and it leaves nothing behind for an uninstaller to find. A task gives us a
 * logon trigger with a delay, "restart on failure", and a single named object that
 * `schtasks /Delete` removes cleanly.
 *
 * The task is generated as XML rather than built from `schtasks` switches, because
 * `schtasks` has no command-line switch for restart-on-failure - it only exists in
 * the XML schema. The XML is asserted directly in the tests, on every load-bearing
 * field: the 20 s delay, the restart count/interval, the hidden `wscript` launch and
 * the quoted path. Constructing the command is the testable part; actually
 * registering the task is not, and is marked unverified on Windows.
 *
 * UNVERIFIED ON WINDOWS: `schtasks.exe` does not exist on this host. No task has
 * ever been registered here.
 */

export const TASK_NAME = 'PuzzleSolver';
export const LOGON_DELAY_SEC = 20;
export const RESTART_INTERVAL = 'PT1M';
export const RESTART_COUNT = 3;

export const TASK_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the task XML. All paths are XML-escaped; the command and argument paths are
 * quoted because `%LOCALAPPDATA%` routinely contains spaces (the user's name).
 *
 * @param {object} options
 * @param {string} options.launcherPath full path to `PuzzleSolver.vbs`
 * @param {string} [options.wscriptPath] `wscript.exe`; defaults to `%SystemRoot%`
 * @param {string} [options.workingDirectory] usually the install dir
 * @param {string} [options.taskName]
 * @param {number} [options.delaySec]
 */
export function buildTaskXml({
  launcherPath,
  wscriptPath = '%SystemRoot%\\System32\\wscript.exe',
  workingDirectory = null,
  taskName = TASK_NAME,
  delaySec = LOGON_DELAY_SEC,
} = {}) {
  if (!launcherPath) throw new Error('buildTaskXml needs a launcherPath');
  if (!(delaySec >= 0)) throw new Error(`delaySec must be >= 0, got ${delaySec}`);
  const workDir = workingDirectory ?? launcherPath.replace(/[\\/][^\\/]*$/, '');
  const delay = delaySec === 0 ? 'PT0S' : `PT${delaySec}S`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="${TASK_NAMESPACE}">
  <RegistrationInfo>
    <Description>PuzzleSolver tray app. Restarts after a crash and starts at logon.</Description>
    <URI>\\${xmlEscape(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>${delay}</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${RESTART_INTERVAL}</Interval>
      <Count>${RESTART_COUNT}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${xmlEscape(wscriptPath)}"</Command>
      <Arguments>"${xmlEscape(launcherPath)}"</Arguments>
      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** `schtasks /Create` arguments for the generated XML. */
export function buildCreateTaskArgs({ xmlPath, taskName = TASK_NAME } = {}) {
  if (!xmlPath) throw new Error('buildCreateTaskArgs needs an xmlPath');
  return ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'];
}

/** `schtasks /Delete` arguments. */
export function buildDeleteTaskArgs({ taskName = TASK_NAME } = {}) {
  return ['/Delete', '/TN', taskName, '/F'];
}

/**
 * Describe the whole install as data - the files to write and the commands to run -
 * without writing or running anything. `install.js` executes the plan; the tests
 * assert it. This is the seam that keeps the deploy logic verifiable on Linux.
 */
export function buildInstallPlan({
  installDir,
  launcherPath = null,
  xmlPath = null,
  taskName = TASK_NAME,
  delaySec = LOGON_DELAY_SEC,
} = {}) {
  if (!installDir) throw new Error('buildInstallPlan needs an installDir');
  const launcher = launcherPath ?? `${installDir}\\PuzzleSolver.vbs`;
  const xml = xmlPath ?? `${installDir}\\PuzzleSolver.task.xml`;
  return {
    target: 'win32',
    files: [
      {
        path: launcher,
        content: null, // filled by the caller from buildLauncherVbs, kept here for shape
      },
      {
        path: xml,
        content: buildTaskXml({ launcherPath: launcher, workingDirectory: installDir, taskName, delaySec }),
      },
    ],
    commands: [{ command: 'schtasks.exe', args: buildCreateTaskArgs({ xmlPath: xml, taskName }) }],
  };
}
