# Hermes in T3 Work

Use T3 Work to manage your Hermes assistants, conversations, scheduled tasks, and results. Switch between Work, Code, and Chat using the existing controls.

## Connect an assistant

Choose **Set up Hermes** in Work or in the Hermes provider settings. T3 finds an existing installation or installs Hermes, creates the local connection, and starts it on the selected computer. You do not need to copy a local token or configure a port. Automatic installation currently supports macOS and Linux; Windows hosts need an existing Hermes installation or a WSL environment.

Setup shows progress and offers a retry if a step fails. If Hermes already has a configured model account, it reuses it. Otherwise, connect an account in the setup panel and choose a model. For supported sign-in providers, open the sign-in page, enter the displayed code, and return to T3. Account sign-in still requires your participation.

Existing remote Hermes connections keep their endpoint and credentials. Advanced connection settings remain available for connecting to a separately managed server.

Work uses the same thread sidebar and conversation view as Code. Each new Work thread starts its own Hermes session; reopening a thread continues that session.

Open a Work thread's details to see its Hermes assistant, session, workspace, and linked scheduled tasks. The workspace is on the computer hosting Hermes, which may be different from the device you are using. Task details include their timing and latest status, with a link to manage schedules. The list updates automatically as tasks are created or changed. Tasks belonging to other conversations are not listed as this thread's tasks.

Open **T3 Work** in Settings to manage assistants and scheduled tasks. Select the environment, connection, and assistant you want to manage. Conversations opened here use the selected assistant's Hermes profile.

Your existing Hermes conversations are available under Conversations. Open one to continue it in T3, or start a new conversation. Memory, skills, and schedules remain owned by Hermes.

## Schedule work

In Scheduled tasks, create a task with its instructions, timing, and delivery destination. For example, use `every 1h` for an hourly check or `in 30m` for a one-time task. You can also ask the assistant to schedule work in conversation.

Review the profile's background service status. The service must be running for unattended tasks to execute. Starting the connection alone does not guarantee that the scheduler is running.

Use the schedule controls to edit, pause, resume, run now, or remove a task. Pausing affects future executions. It does not mean a run already in progress has stopped. Removing a task does not erase results already synchronized into T3.

Hermes schedules and T3 scheduled tasks for other providers have different execution owners. Creating a Hermes schedule does not create a second T3 timer.

## Read results

Open a schedule's run history to inspect its individual runs, then select a run to read the output. The broader run list includes activity discovered from Hermes even when you did not start it in T3.

The T3 environment checks for background activity while its server is running. Reconnecting a client does not rerun the task. When Hermes does not report an outcome, T3 shows the uncertainty instead of assuming success.

A task's execution and its delivery are separate outcomes. A result saved locally does not mean it was sent to a messaging channel. Choose and configure the destination you intend to use.

## Work while away

Closing a browser window does not stop a separately running Hermes background service. Shutting down its hosting machine makes that environment unavailable. Use an environment that remains online for overnight or recurring responsibilities.

If a change loses its connection before Hermes confirms it, refresh the state before repeating the action: the change may already have completed.

## Manage the assistant

The management view provides instructions, memory, skills, messaging configuration, and files for the selected assistant. Check the selected environment and assistant before saving changes. Memory edits can be rejected if Hermes changed that memory after you opened it; reload before editing again.

Group conversations let assistants collaborate. Their messages and controls remain attached to the selected connection and group.

For Hermes's schedule formats and execution behavior, see the [official scheduled tasks guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).
