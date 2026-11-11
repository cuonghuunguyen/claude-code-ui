Feature: Open an artifact as a tab (GH-400) and the Artifact link menu (GH-512)

  # The session is a synthetic transcript of an Artifact publish of dash.html (a real publish would go to claude.ai), served by the scenario's own daemon with a CLAUDE_CONFIG_DIR inside the run folder: no model, nothing in the real ~/.claude.
  Scenario: Open in tab from the Artifact card, twice keeps one tab, the card and the tab are independent, the tab is restored after a reload
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 1440x900
    And I note the page URL
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    Then the artifact tab "Sales dashboard" opens right of its session tab, active and focused
    And the artifact tab shows the page with the heading "Sales dashboard"
    And the page of the artifact tab fills the tab
    And the artifact tab has Reload and the offline line
    And the page URL is unchanged
    And I capture "artifact-tab-open"
    When I click the session tab "Publish the dashboard"
    And I click Open in tab on the Artifact card
    Then there is one artifact tab "Sales dashboard"
    And the artifact tab "Sales dashboard" is active and focused
    And I capture "artifact-tab-twice"
    When I click the session tab "Publish the dashboard"
    And I click Show preview on the Artifact card
    And I click Open in tab on the Artifact card
    And I close the artifact tab "Sales dashboard"
    Then the Artifact card still shows the page
    When I click Open in tab on the Artifact card
    And I click the session tab "Publish the dashboard"
    And I click Hide preview on the Artifact card
    And I click the artifact tab "Sales dashboard"
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And I capture "artifact-tab-independent"
    When I reload the page
    Then there is one artifact tab "Sales dashboard"
    When I click the artifact tab "Sales dashboard"
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And I capture "artifact-tab-reload"

  Scenario: The artifact tab shows the page again after a daemon restart
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 1440x900
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I restart the artifact daemon
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And I capture "artifact-tab-daemon-restart"

  Scenario: Split right shows the artifact beside its session; a page that is gone is reported
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 1440x900
    And I hide the side panel
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I choose "Split right" in the menu of the artifact tab "Sales dashboard"
    Then the artifact tab "Sales dashboard" is shown in a split
    And the artifact split fills its half
    And I capture "artifact-tab-split"
    When I delete the project file "dash.html"
    And I click Reload in the artifact tab
    Then the artifact tab shows the error "Preview not available: file is gone"
    And I capture "artifact-tab-file-gone"

  Scenario: Phone: the tab switcher lists the artifact and the page fits
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 390x844
    When I expand the Artifact card
    And I click Open in tab on the Artifact card
    And I open the tab switcher
    Then the tab switcher lists the artifact row "Sales dashboard"
    When I pick the artifact row "Sales dashboard" in the tab switcher
    Then the artifact tab shows the page with the heading "Sales dashboard"
    And the page has no horizontal scroll
    And I capture "artifact-tab-phone"

  Scenario: Card link click offers Preview, Open in tab and Open on claude.ai, with the mouse and the keyboard
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 1440x900
    When I expand the Artifact card
    And I click the claude.ai link of the Artifact card
    Then the link menu offers Preview, Open in tab and Open on claude.ai
    And I capture "artifact-link-menu-card"
    When I choose "preview" in the link menu
    Then the Artifact card shows the inline preview
    And I capture "artifact-link-menu-preview"
    When I click the claude.ai link of the Artifact card
    And I choose "tab" in the link menu
    Then the artifact tab opens in the main area active
    And I capture "artifact-link-menu-open-in-tab"
    When I click the session tab "Publish the dashboard"
    And I open the link menu of the Artifact card with the keyboard
    Then the link menu offers Preview, Open in tab and Open on claude.ai
    And the first link menu item has the focus
    When I Tab through the link menu to Open on claude.ai
    And I capture "artifact-link-menu-keyboard"
    And I press Escape in the link menu
    Then the Artifact card link has the focus

  Scenario: The link in assistant text offers only Open in tab and Open on claude.ai; a modified or middle click keeps the native new tab
    Given a session that published the page "dash.html" and replied with its link
    And the viewport is 1440x900
    When I click the claude.ai link in the assistant text
    Then the link menu offers only Open in tab and Open on claude.ai
    And I capture "artifact-link-menu-text"
    When I choose "tab" in the link menu
    Then the artifact tab opens in the main area active
    And I capture "artifact-link-menu-text-open-in-tab"
    When I click the session tab "Publish the dashboard"
    And I expand the Artifact card
    Then a modified or middle click on the "card" link opens a new browser tab without a menu
    And a modified or middle click on the "text" link opens a new browser tab without a menu
    And I capture "artifact-link-menu-native"

  Scenario: Phone: link menu items are 44 px
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 390x844
    And the device has a coarse touch pointer
    When I expand the Artifact card
    And I click the claude.ai link of the Artifact card
    Then the link menu offers Preview, Open in tab and Open on claude.ai
    And every link menu item is at least 44 px high
    And the page has no horizontal scroll
    And I capture "artifact-link-menu-phone"
