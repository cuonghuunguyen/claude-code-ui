Feature: Artifact link menu (GH-512)

  # Synthetic transcripts (a real publish would go to claude.ai), served by the scenario's own daemon.
  Scenario: Card link click offers Preview, Open in tab and Open on claude.ai
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

  Scenario: Card link menu is reachable by keyboard
    Given a session that published the page "dash.html" titled "Sales dashboard"
    And the viewport is 1440x900
    When I expand the Artifact card
    And I open the link menu of the Artifact card with the keyboard
    Then the link menu offers Preview, Open in tab and Open on claude.ai
    And the first link menu item has the focus
    When I Tab through the link menu to Open on claude.ai
    And I capture "artifact-link-menu-keyboard"

  Scenario: The link in assistant text offers only Open in tab and Open on claude.ai
    Given a session that published the page "dash.html" and replied with its link
    And the viewport is 1440x900
    When I click the claude.ai link in the assistant text
    Then the link menu offers only Open in tab and Open on claude.ai
    And I capture "artifact-link-menu-text"
    When I choose "tab" in the link menu
    Then the artifact tab opens in the main area active
    And I capture "artifact-link-menu-text-open-in-tab"

  Scenario: Modified or middle click keeps the native new tab
    Given a session that published the page "dash.html" and replied with its link
    And the viewport is 1440x900
    When I expand the Artifact card
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
