Feature: Create worktree modal

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin

  Scenario: The button opens the modal and the Name tab creates a worktree from a new branch
    Given I open the scratch project
    When I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    When I open the "name" tab of the modal
    And I type the worktree name "feat/x"
    Then the modal shows branch "feat/x" in folder ".claude/worktrees/feat-x"
    When I type the worktree name "Fix Login Ü"
    Then the modal shows branch "fix-login-u" in folder ".claude/worktrees/fix-login-u"
    And I capture "name tab"
    When I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "fix-login-u"
    And the worktree folder "fix-login-u" is on branch "fix-login-u"
    And I capture "new session in worktree"

  Scenario: The Base picker creates the branch from a non-default ref
    Given I open the scratch project
    When I click the new worktree button of the scratch project
    And I open the "name" tab of the modal
    And I type the worktree name "from-alt"
    And I choose the base "refs/heads/base-alt"
    And I capture "base picker"
    And I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "from-alt"
    And the worktree folder "from-alt" has the same commit as "refs/heads/base-alt"
    And I capture "created from base-alt"

  Scenario: The Branch tab checks out a remote-only branch as a local tracking branch
    Given I open the scratch project
    When I click the new worktree button of the scratch project
    And I open the "branch" tab of the modal
    Then the main branch row is disabled
    And the branch list shows "feat/remote" as "Remote"
    When I pick the branch row "feat/remote"
    Then the Check out button is shown
    And I capture "branch tab"
    When I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "feat/remote"
    And the worktree folder "feat-remote" is on branch "feat/remote"
    And the branch "feat/remote" of the worktree folder "feat-remote" tracks "origin/feat/remote"
    And I capture "remote branch checked out"

  Scenario: The Branch tab still lists local branches when origin is unreachable
    Given the origin of the scratch project is unreachable
    And I open the scratch project
    When I click the new worktree button of the scratch project
    And I open the "branch" tab of the modal
    Then the modal says origin could not be fetched
    And the branch list shows "base-alt" as "Local"
    And I capture "offline"

  Scenario: The Ticket tab lists my Jira tickets and creates a branch from a Bug
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I set up Jira in Settings with the fake Jira
    Then Jira reports it is connected as "Ann Example"
    And I capture "settings jira"
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    Then the ticket rows are "PRJ-1, PRJ-2"
    When I search tickets for "PRJ-3"
    Then the ticket rows are "PRJ-3"
    When I search tickets for "indexing"
    Then the ticket rows are "PRJ-3"
    When I search tickets for the Jira URL of "PRJ-2"
    Then the ticket rows are "PRJ-2"
    When I search tickets for ""
    And I pick the ticket "PRJ-1"
    Then the ticket branch name starts with "bugfix/PRJ-1-"
    When I change the ticket branch name to "bugfix/PRJ-1-login-fix"
    And I capture "ticket tab"
    And I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "bugfix/PRJ-1-login-fix"
    And the worktree folder "bugfix-PRJ-1-login-fix" is on branch "bugfix/PRJ-1-login-fix"
    And I capture "ticket worktree"

  Scenario: A ticket whose key already has a remote branch offers to check it out
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I set up Jira in Settings with the fake Jira
    Then Jira reports it is connected as "Ann Example"
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    And I pick the ticket "PRJ-2"
    Then the modal offers to check out the existing branch "feature/PRJ-2-old-try"
    And I capture "existing branch offer"
    When I check out the existing branch
    Then the modal closes
    And the new-session tab runs in the worktree "feature/PRJ-2-old-try"
    And the worktree folder "feature-PRJ-2-old-try" is on branch "feature/PRJ-2-old-try"
    And I capture "existing branch checked out"

  Scenario: Shift+click creates a worktree at once with a generated name
    Given I open the scratch project
    When I shift-click the new worktree button of the scratch project
    Then no Create worktree modal is open
    And a worktree with a generated name exists
    And the new-session tab runs in a worktree with a generated name
    And I capture "shift click"

  Scenario: The modal fits a phone screen and opens from the project menu
    Given the viewport is 390x844
    And I open the scratch project
    When I choose "create-worktree" in the menu of the scratch project
    Then the Create worktree modal is open
    And the modal fits the viewport
    When I open the "name" tab of the modal
    And I type the worktree name "phone"
    And I open the "branch" tab of the modal
    Then the modal fits the viewport
    And I capture "phone modal"

  Scenario: The project menu creates a worktree at once on a phone
    Given the viewport is 390x844
    And I open the scratch project
    When I choose "new-worktree" in the menu of the scratch project
    Then no Create worktree modal is open
    And a worktree with a generated name exists
    And the new-session tab runs in a worktree with a generated name
    And I capture "phone quick create"

  Scenario: A new worktree gets the gitignored files .worktreeinclude lists and nothing else
    Given the scratch project has gitignored files listed in .worktreeinclude
    And I open the scratch project
    When I click the new worktree button of the scratch project
    And I open the "name" tab of the modal
    And I type the worktree name "with-env"
    And I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "with-env"
    And the worktree folder "with-env" has ".env" with the main checkout's content
    And the worktree folder "with-env" has "config/local.env" with the main checkout's content
    And the worktree folder "with-env" has no "skip.log"
    And the worktree folder "with-env" keeps the committed content of "tracked.env"
    And I capture "worktreeinclude copied"

  Scenario: Shift+click also copies the files .worktreeinclude lists
    Given the scratch project has gitignored files listed in .worktreeinclude
    And I open the scratch project
    When I shift-click the new worktree button of the scratch project
    Then no Create worktree modal is open
    And a worktree with a generated name exists
    And the new-session tab runs in a worktree with a generated name
    And the generated worktree has ".env" with the main checkout's content
    And I capture "shift click worktreeinclude"

  Scenario: A wholly ignored folder is copied only when .worktreeinclude names it
    Given the scratch project has an ignored node_modules and an ignored vendor folder with a .worktreeinclude of config.json files
    And I open the scratch project
    When I click the new worktree button of the scratch project
    And I open the "name" tab of the modal
    And I type the worktree name "with-vendor"
    And I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "with-vendor"
    And the worktree folder "with-vendor" has "vendor/lib/config.json" with the main checkout's content
    And the worktree folder "with-vendor" has "vendor/data.txt" with the main checkout's content
    And the worktree folder "with-vendor" has no "node_modules/pkg/config.json"
    And I capture "worktreeinclude ignored folder"
