Feature: Annotate (git blame) gutter in the Files editor (GH-564)

  Background:
    Given the scratch project is a git repository with two commits

  Scenario: Annotate shows author, date and short hash per line and its markers work from the keyboard
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/app.ts"
    And I type a new first line in the Files editor
    And I save the Files editor
    And I turn on Annotate
    Then the Annotate gutter shows a short hash
    And the Annotate gutter shows "not committed"
    And I capture "annotate-gutter"
    When I Tab from Annotate to the first commit marker
    And I press "Enter"
    Then the Git graph shows the selected commit "second commit"
    And I capture "annotate-keyboard-enter"

  Scenario: Clicking an annotation opens the commit in the Git graph
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/app.ts"
    And I turn on Annotate
    Then the Annotate gutter shows a short hash
    When I click the first Annotate entry
    Then the Git graph shows the selected commit "second commit"
    And I capture "annotate-graph"

  Scenario: Annotate and the Timeline fit a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/app.ts"
    And I open the Timeline
    Then the Timeline lists "second commit"
    And the page is exactly 390px wide
    And every Timeline row is at least 44px high
    And I capture "timeline-phone"
    When I close the file tree drawer
    And I turn on Annotate
    Then the Annotate gutter shows a short hash
    And the page is exactly 390px wide
    And the Annotate button is at least 44px high
    And I capture "annotate-phone"
