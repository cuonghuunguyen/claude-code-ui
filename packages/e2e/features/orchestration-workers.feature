Feature: Orchestration workers: targets, worker trees and closing finished workers

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with its own worktree
    And I open the scratch project
    And I enable orchestration in Settings
    And I start a new Haiku session

  Scenario: worker_targets lists the project and its worktree
    When I send "Load the worker_targets tool with ToolSearch (query select:mcp__orchestration__worker_targets), then call it with no arguments. Do nothing else." with the scratch project and worktree names filled in
    Then the "worker_targets" tool card is shown and finished
    And the "worker_targets" tool card lists the scratch project and its worktree
    And the turn has finished
    And I capture "worker targets listed"

  Scenario: worker_start by project asks with the project name and starts in the main checkout
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"project\":\"<project>\",\"prompt\":\"Reply with exactly: OK\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    And the permission request names the scratch project
    And I capture "project card"
    When I allow the permission request
    Then a worker session runs in the main checkout of the scratch project
    And I capture "worker in main checkout"

  Scenario: worker_start by worktree asks with project and worktree names and starts in that worktree
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"worktree\":\"<worktree>\",\"prompt\":\"Reply with exactly: OK\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    And the permission request names the scratch worktree and the scratch project
    And I capture "worktree card"
    When I allow the permission request
    Then a worker session runs in the scratch worktree
    And I capture "worker in worktree"

  Scenario: worker_start with an unknown name fails and starts nothing
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"project\":\"no-such-project-zz\",\"prompt\":\"Reply with exactly: OK\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the "worker_start" tool card failed
    And the "worker_start" tool card shows an error that names no such project
    And no worker session exists for the scratch project
    And I capture "unknown name"

  Scenario: worker_start with a new branch gets the .worktreeinclude files
    Given the scratch project has gitignored files listed in .worktreeinclude
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"repo\":\"<project>\",\"branch\":\"<branch>\",\"prompt\":\"Reply with exactly: OK. Do nothing else.\"}. Do nothing else." with the scratch project and a new branch name filled in
    Then I see a permission request
    When I allow the permission request
    Then the worktree folder of the new branch has ".env" with the main checkout's content
    And the worktree folder of the new branch has no "skip.log"
    And I capture "worker worktreeinclude"

  Scenario: Settings shows the worker tree limits
    When I open Settings › Orchestration
    Then the Orchestration setting "Maximum tree depth" is 2
    And the Orchestration setting "Maximum workers per coordinator" is 4
    And the Orchestration setting "Maximum workers per tree" is 4
    And the Orchestration setting "Maximum workers in total" is 0
    And the hint of the Orchestration setting "Maximum workers in total" mentions "this daemon"
    And I capture "tree limits desktop"
    When I set the Orchestration setting "Maximum tree depth" to 9
    Then the Settings error mentions "Maximum tree depth"
    And I capture "tree depth out of range"
    When the viewport is 390x844
    Then the Orchestration setting "Maximum workers per coordinator" is 4
    And the Orchestration setting "Maximum workers in total" is 0
    And the page has no horizontal scroll
    And I capture "tree limits phone"

  Scenario: The worker tree limits persist and refuse invalid values
    When I open Settings › Orchestration
    Then the hint of the Orchestration setting "Maximum workers in total" mentions "this daemon"
    When I set the Orchestration setting "Maximum workers per tree" to 7
    And I set the Orchestration setting "Maximum workers in total" to 12
    And I reload the page
    And I open Settings › Orchestration
    Then the Orchestration setting "Maximum workers per tree" is 7
    And the Orchestration setting "Maximum workers in total" is 12
    And I capture "tree limits persisted"
    When I set the Orchestration setting "Maximum workers in total" to 101
    Then the Settings error mentions "Maximum workers in total"
    When I set the Orchestration setting "Maximum workers in total" to -1
    Then the Settings error mentions "Maximum workers in total"
    When I type "abc" into the Orchestration setting "Maximum workers per tree"
    Then the Settings error mentions "Maximum workers per tree"
    And I capture "tree limits invalid"
    When I reload the page
    And I open Settings › Orchestration
    Then the Orchestration setting "Maximum workers per tree" is 7
    And the Orchestration setting "Maximum workers in total" is 12
    When I set the Orchestration setting "Maximum workers per tree" to 4
    And I set the Orchestration setting "Maximum workers in total" to 0
    Then the Orchestration setting "Maximum workers in total" is 0

  Scenario: The worker's worker lists under the root coordinator
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 20
    And I close Settings
    And I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Then call worker_start exactly once with name parent, project <project>, and as its prompt exactly the text between BEGIN and END. BEGIN Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call worker_start exactly once with name child, project <project>, and prompt: Reply with exactly: OK. Do nothing else. END. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    And I open the worker "parent"
    Then I see a permission request whose title contains "started by worker parent"
    When I allow the permission request
    Then the sidebar lists the worker "parent"
    And the sidebar lists the worker "parent › child"
    And I capture "tree in sidebar desktop"
    When the viewport is 390x844
    Then the sidebar lists the worker "parent › child"
    When I show the sidebar
    Then the sidebar lists the worker "parent › child"
    And the page has no horizontal scroll
    And I capture "tree in sidebar phone"

  Scenario: A worker at the depth limit cannot start a worker
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 20
    And I set the Orchestration setting "Maximum tree depth" to 1
    And I close Settings
    And I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Then call worker_start exactly once with name parent, project <project>, and as its prompt exactly the text between BEGIN and END. BEGIN Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call worker_start exactly once with name child, project <project>, and prompt: Reply with exactly: OK. Do nothing else. END. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the sidebar lists the worker "parent"
    When I open the worker "parent"
    Then the "worker_start" tool card failed
    And the "worker_start" tool card shows an error that names the depth limit
    And no permission request is shown
    And the sidebar does not list the worker "parent › child"
    And I capture "depth limit"

  Scenario: Settings shows Close finished workers on, in English and Vietnamese
    When I open Settings › Orchestration
    Then the Orchestration switch "Close finished workers" is on
    And the Orchestration switch row "Stall alert after (minutes)" shows its label
    And I capture "close finished setting desktop"
    When the viewport is 390x844
    Then the Orchestration switch "Close finished workers" is on
    And the page has no horizontal scroll
    And I capture "close finished setting phone"
    When I close Settings
    And I show the sidebar
    And I switch the language to Vietnamese
    And I open the sidebar drawer if the phone layout hides it
    And I open Settings › Orchestration
    Then the Orchestration switch row "Đóng worker đã xong" shows its label
    And the Orchestration switch "Đóng worker đã xong" is on
    And the Orchestration switch row "Cảnh báo treo sau (phút)" shows its label
    And the page has no horizontal scroll
    And I capture "close finished setting phone vi"
    When the viewport is 1440x900
    Then the Orchestration switch "Đóng worker đã xong" is on
    And I capture "close finished setting desktop vi"
    When I close Settings
    And I switch the language to English

  Scenario: With a limit of 1, a second worker starts after the first finished, without a close
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 1
    And I close Settings
    And I send "Load the worker_start and worker_wait tools with ToolSearch (query select:mcp__orchestration__worker_start,mcp__orchestration__worker_wait). Call worker_start with name first, project <project>, prompt: Reply with exactly: OK. Then call worker_wait once with timeoutMs 120000. Then call worker_start with name second, project <project>, prompt: Reply with exactly: OK. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the sidebar worker "first" is closed
    When I allow the permission request
    Then the sidebar lists the worker "second"
    And the sidebar worker "first" is closed
    And the chat shows no stalled notice
    And I capture "second worker after first closed"
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 4
    Then the Orchestration setting "Maximum workers per tree" is 4

  Scenario: A worker started with keepOpen stays live
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Call worker_start with name kept, project <project>, keepOpen true, prompt: Reply with exactly: OK. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the sidebar lists the worker "kept"
    And the sidebar worker "kept" stays idle
    And I capture "keepOpen worker stays idle"

  Scenario: A worker open in a tab stays live
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Call worker_start with name tabbed, project <project>, prompt: Run exactly this command with the Bash tool: sleep 20. Then reply with exactly: OK. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    And I open the worker "tabbed"
    Then the sidebar worker "tabbed" stays idle
    And I capture "worker in a tab stays idle"

  Scenario: With the setting off a finished worker stays idle
    When I open Settings › Orchestration
    And I turn the Orchestration switch "Close finished workers" off
    Then the Orchestration switch "Close finished workers" is off
    And I capture "close finished setting off"
    When I close Settings
    And I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Call worker_start with name offworker, project <project>, prompt: Reply with exactly: OK. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the sidebar lists the worker "offworker"
    And the sidebar worker "offworker" stays idle
    And I capture "setting off worker stays idle"
    When I open Settings › Orchestration
    And I turn the Orchestration switch "Close finished workers" on
    Then the Orchestration switch "Close finished workers" is on
