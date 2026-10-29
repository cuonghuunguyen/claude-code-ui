Feature: Artifacts pane (GH-176)

  # The sessions are synthetic transcripts (a real publish would go to claude.ai), served by the scenario's own daemon with a CLAUDE_CONFIG_DIR inside the run folder: no model, nothing in the real ~/.claude.
  # 12 turns are more than one page (10 turns): the publishes of turns 1 and 2 are not in the loaded page.

  Scenario: Artifacts lists publishes older than the loaded page
    Given a session of 12 turns that published report.html, chart.html, notes.md and chart.html again
    And the viewport is 1440x900
    Then the side panel lists the Artifacts tab
    When I open the Artifacts pane
    Then the Artifacts pane lists 3 rows in the order "chart.html, notes.md, report.html"
    And each Artifacts row shows a relative time
    And I capture "artifacts-pane-list"

  Scenario: No Artifacts tab without a publish
    Given a session of 3 turns without a publish
    And the viewport is 1440x900
    Then the side panel has no Artifacts tab
    And I capture "artifacts-pane-none"

  Scenario: Preview, open in tab and move back
    Given a session of 12 turns that published report.html, chart.html, notes.md and chart.html again
    And the viewport is 1440x900
    When I open the Artifacts pane
    And I select the artifact "report.html" in the Artifacts pane
    Then the Artifacts pane previews the page with the heading "Report page"
    When I select the artifact "notes.md" in the Artifacts pane
    Then the Artifacts pane says No local preview with a claude.ai link
    When I select the artifact "report.html" in the Artifacts pane
    And I click Open in tab in the Artifacts pane
    Then the artifact tab "report.html" is active and focused
    When I choose "Move to Artifacts" in the menu of the artifact tab "report.html"
    Then the artifact tab "report.html" is closed
    And the Artifacts pane has "report.html" selected
    And I capture "artifacts-pane-move-back"

  Scenario: Artifacts moves to the bottom panel and the main area
    Given a session of 12 turns that published report.html, chart.html, notes.md and chart.html again
    And the viewport is 1440x900
    When I move the Artifacts pane to the bottom panel from its tab menu
    Then the bottom panel lists the Artifacts tab
    And the side panel has no Artifacts tab
    When I move the Artifacts pane to the main area from its tab menu
    Then there is one Artifacts tab in the main area
    When I reload the page
    Then there is one Artifacts tab in the main area
    And I capture "artifacts-pane-main"

  Scenario: Narrow switcher lists Artifacts
    Given a session of 12 turns that published report.html, chart.html, notes.md and chart.html again
    And the viewport is 900x800
    Then the pane switcher lists Artifacts
    When I pick Artifacts in the pane switcher
    Then the Artifacts pane lists 3 rows in the order "chart.html, notes.md, report.html"
    And I capture "artifacts-pane-narrow"

  Scenario: Phone: list and preview fit 390 px
    Given a session of 12 turns that published report.html, chart.html, notes.md and chart.html again
    And the viewport is 390x844
    When I pick Artifacts in the pane switcher
    Then the Artifacts pane lists 3 rows in the order "chart.html, notes.md, report.html"
    And the page has no horizontal scroll
    When I select the artifact "report.html" in the Artifacts pane
    Then the Artifacts pane shows the preview and the All artifacts button
    And the page has no horizontal scroll
    When I go back to all artifacts
    Then the Artifacts pane lists 3 rows in the order "chart.html, notes.md, report.html"
    And I capture "artifacts-pane-phone"

  Scenario: The Artifacts pane lists the same rows after a daemon restart
    Given a session of 12 turns that published report.html, chart.html, notes.md and chart.html again
    And the viewport is 1440x900
    When I open the Artifacts pane
    And I select the artifact "report.html" in the Artifacts pane
    And I restart the Artifacts daemon
    Then the Artifacts pane lists 3 rows in the order "chart.html, notes.md, report.html"
    And the Artifacts pane previews the page with the heading "Report page"
    And I capture "artifacts-pane-daemon-restart"
