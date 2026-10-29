Feature: Open an artifact as a tab (GH-400)

  # The session is a synthetic transcript of an Artifact publish of dash.html (a real publish would go to claude.ai).
  Background:
    Given a session that published the page "dash.html" titled "Sales dashboard"

  Scenario: Open in tab from the Artifact card
    Given the viewport is 1440x900
    And I note the page URL
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    Then the artifact tab "Sales dashboard" opens right of its session tab, active and focused
    And the artifact tab shows the page with the heading "Sales dashboard"
    And the page of the artifact tab fills the tab
    And the artifact tab has Reload and the offline line
    And the page URL is unchanged
    And I capture "artifact-tab-open"

  Scenario: Open in tab twice keeps one tab
    Given the viewport is 1440x900
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I click the first session tab
    And I click Open in tab on the Artifact card
    Then there is one artifact tab "Sales dashboard"
    And the artifact tab "Sales dashboard" is active and focused
    And I capture "artifact-tab-twice"

  Scenario: The card and the tab are independent
    Given the viewport is 1440x900
    When I expand the Artifact card
    And I click Show preview on the Artifact card
    And I click Open in tab on the Artifact card
    And I close the artifact tab "Sales dashboard"
    Then the Artifact card still shows the page
    When I click Open in tab on the Artifact card
    And I click the first session tab
    And I click Hide preview on the Artifact card
    And I click the artifact tab "Sales dashboard"
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And I capture "artifact-tab-independent"

  Scenario: The artifact tab is restored after a page reload
    Given the viewport is 1440x900
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I reload the page
    Then there is one artifact tab "Sales dashboard"
    When I click the artifact tab "Sales dashboard"
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And I capture "artifact-tab-reload"

  Scenario: The artifact tab shows the page again after a daemon restart
    Given the viewport is 1440x900
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I restart the daemon
    Then the app is connected
    And the artifact tab shows the page with the heading "Sales dashboard"
    And I capture "artifact-tab-daemon-restart"

  Scenario: A page that is gone is reported
    Given the viewport is 1440x900
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I delete the project file "dash.html"
    And I click Reload in the artifact tab
    Then the artifact tab shows the error "Preview not available: file is gone"
    And I capture "artifact-tab-file-gone"

  Scenario: Split right shows the artifact beside its session
    Given the viewport is 1440x900
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I choose "Split right" in the menu of the artifact tab "Sales dashboard"
    Then the artifact tab "Sales dashboard" is shown in a split
    And the artifact split fills its half
    And I capture "artifact-tab-split"

  Scenario: Phone: the tab switcher lists the artifact and the page fits
    Given the viewport is 390x844
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I open the tab switcher
    Then the tab switcher lists the artifact row "Sales dashboard"
    When I pick the artifact row "Sales dashboard" in the tab switcher
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And the page has no horizontal scroll
    And I capture "artifact-tab-phone"
