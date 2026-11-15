Feature: Orchestration workers: targets, worker trees and closing finished workers

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with its own worktree
    And I open the scratch project
    And I enable orchestration in Settings
    And I start a new Haiku session

  Scenario: worker_start by project asks with the project name and starts in the main checkout
    When I send "Load the worker_start and worker_wait tools with ToolSearch (query select:mcp__orchestration__worker_start,mcp__orchestration__worker_wait). Call worker_start with name probe, project <project>, prompt: Use the AskUserQuestion tool exactly once. Ask which color to use. Offer two options, Red and Blue. Then reply with exactly the chosen color. Then call worker_wait once with timeoutMs 240000. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    And the permission request names the scratch project
    And I capture "project card"
    When I allow the permission request
    Then a worker session runs in the main checkout of the scratch project
    And I capture "worker in main checkout"
    When I open Focus
    And I select the question request in Focus
    Then the Focus detail has a Question card
    When I answer the question with its first option
    And I click the first session tab
    Then the "worker_wait" tool card is shown and finished
    And I capture "worker result read"
