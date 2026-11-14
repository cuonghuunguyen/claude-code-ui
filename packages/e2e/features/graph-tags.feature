Feature: Graph tags: New Tag and Remove Tag (GH-666)

  Scenario: New Tag creates a lightweight and an annotated tag
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    And I start New Tag from the commit menu
    And I type the tag name "v1"
    Then the tag dialog shows the command "git tag v1"
    And I capture "new-tag-lightweight"
    When I confirm the tag dialog
    Then the Graph result line says "Created tag v1"
    And the tag "v1" is a lightweight tag of the last commit
    And the commit row "local work" shows the tag chip "v1"
    When I open the commit menu on the row "local work"
    And I start New Tag from the commit menu
    And I type the tag name "v2"
    And I type the tag message "second release"
    Then the tag dialog shows the command "git tag -a -m \"second release\" v2"
    And I capture "new-tag-annotated"
    When I confirm the tag dialog
    Then the Graph result line says "Created tag v2"
    And the tag "v2" is an annotated tag

  Scenario: Remove Tag deletes locally, and on origin only when asked
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the scratch project has the tag "v1" on origin and the tag "v2" only locally
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the context menu on the tag chip "v2"
    And I pick "Remove Tag…" in the tag chip menu
    Then the tag dialog shows the command "git tag -d v2"
    And the Remove Tag dialog has no remote option
    And I capture "remove-tag-local-only"
    When I cancel the tag dialog
    And I open the context menu on the tag chip "v1"
    And I pick "Remove Tag…" in the tag chip menu
    Then the Remove Tag dialog offers "Also delete on origin" unchecked
    And the tag dialog shows the command "git tag -d v1"
    And I capture "remove-tag-remote-option"
    When I check "Also delete on origin" in the Remove Tag dialog
    Then the tag dialog shows the command "--delete refs/tags/v1"
    And I capture "remove-tag-remote-checked"
    When I confirm the tag dialog
    Then the Graph result line says "Deleted tag v1"
    And the project has no tag "v1"
    And the origin has no tag "v1"
    And the origin has the tag "v2" if it was pushed
    And I capture "removed-tag"

  Scenario: The tag dialogs fit a phone
    Given the viewport is 390x844
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    And I start New Tag from the commit menu
    And I type the tag name "release-candidate-with-a-very-long-name-1"
    And I type the tag message "a message that is long enough to make the command wrap onto several lines"
    Then the page has no horizontal scroll
    And I capture "new-tag-phone"
