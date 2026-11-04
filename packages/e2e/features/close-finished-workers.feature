Feature: Finished workers close their Claude process by themselves

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with its own worktree
    And I open the scratch project
    And I enable orchestration in Settings
    And I start a new Haiku session

  Scenario: Settings shows Close finished workers on, in English and Vietnamese
    When I open Settings › Orchestration
    Then the Orchestration switch "Close finished workers" is on
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
