- Admission and intake workflow - Ok
- Patient views and subviews - Ok
- Hope workflows - Hope assessment, HUV1, HUV2, SFV, Discharge assessment, admission assessment - Ok
- Put alerts for each sections of the hope assessment - Ok
- Patient care plan - Ok
- Add a button for new encounter and new visit - Ok
- Patient assessment  - Ok
"What the Assessment CoversPhysical Health: Tracking pain levels, breathing issues, fatigue, and other distressing symptoms.Functional Status: Measuring the patient's ability to perform daily tasks like eating, bathing, and walking.Psychosocial Needs: Evaluating how the patient and their family are coping emotionally and managing home dynamics.Spiritual Care: Identifying personal beliefs, values, or end-of-life rituals that bring comfort"
- Patient document: upload patient documents (from intake), polst, consent forms - Ok
- Referral inbox: upload file received from email, fax, pdf, word, physical copy that we need to scans - Ok

- Hearthnote*

# Admission workflow

- In the "Complete admission details" modal, the "Service location" should be the patient's residence address - Ok
- Notice of Rights can be scanned and uploaded - Ok
- Election Statement can be scanned and uploaded - Ok
- Sign Election Statement can be scanned and uploaded - Ok
- In the Sign Election Statement modal, put the option "care giver" as Signer role - Ok
- The CTI should be created and signed by the hospice physician ONLY (the one that we selected) - Ok
- Search for doctor's name - Ok
- In the "Create Certification of Terminal Illness" put the secondeary diagnisis field (it can be multiple) - Ok
- When signing the CTI, the doctor's name and NPI should pop up automatically - Ok
- In an encounter/visit, we should be able to create directly a care plan - Ok
- The care plan is dynamic, it can change when the patient condition change - Ok
- In the patient care creation, SNOMED code must be linked to ICD-10 code so that hen we type the ICD-10 code, it auto complet the SNOMED code
- In the patient care creation, when we hover the SUD-related checkbox we should see a definition of what it is - Ok
- In care plan workflow, once the care plan is reviewed, we send it to the hospice physician to review and sign - Ok

- Hope workflow, HUV1, HUV2, SFV - Ok
- Discharge


- HOPE - Section A - Patient middle initial, Patient name suffix (check if optionnal or not) - Ok
- The patient can either have medicaid, medicare or both - Ok
- Prefered language: add a selection option - Ok
- Facility National Provider Identifier (NPI) and Facility CMS Certification Number (CCN) should be selected - Ok
- Patient zip code should be workflow controlled - Ok
- Section J: 500 error while clicking on Yes - Ok
- Give a clear message to users when they don't have the permissions to complete a SFV - Ok
- Give the possibility to review the SFV and put it in the  - Ok
- Review Payer / Coverage - Ok
- Move the Hope in the patient subview below "Care Team & Assignments" - Ok
- Fix the patient subview changing - Ok
- In the ENcounters / visits view, the button should say "New encounter" - Ok
- In the encounters, show the error next to the fields - Ok
- Complete Admission modal in the HOPE admission should be centered - Ok
- In the encounters, there should be a button to take the user to the care plan (view care plan & create new care plan buttons) - Ok
- Hide the section 5 in the encounter (VISIT LOGISTICS) - Ok
- Add the patient address from the referral inbox - Ok
- In the patient views Demographics & Identifiers & Addresses, improve the UI/UX - Ok
- SHow the Coverage / Payers from the HOPE assessment or in the beggining they give it to use in the referral box, it needs to auto complete - Ok
- Review the care plan view - Ok
- Show alerts to the users - Ok
- When a F2F or CTI is needed is due (7 days before, 3 days before and 1 day after the due day), the system should alert the responsible party (doctor, nurse and administrator) - Ok
- When signing the Election Statement, auto complete the current user's name in the signer name field - Ok (Not what the business logic waits)
- Move CTI (Certify Terminal Illness) and Face 2 Face in the patient subview (can be modified only by the doctor/MD and viewed by the other) - Ok
- In the Election & Certification, we should have the possibility to create a CTI and a F2F (only by the MD) and the others can view it - Ok
- WHen selecting "other" in prefered language in the HOPE admission, we need to have an input to collect that language - Ok
- The signature of the CTI, add a window of 3 days for the doctor to sign it - Ok
- admissions/c9b161bc-4d91-4159-b2b7-ca930260e9ad/hope should be in the patient view - Ok
- In the care plan, show properly the error to the user - Ok
- Payer / Coverage in the HOPE admission (need attention) - Ok
- Election Statement we need to register who uplaoded the document - Ok
- An RN should have the possibility to manage a patient HOPE and Care Plan, create an encounter - Ok
- Erreur 404 sur le rôle nurse (RN) - Ok

- Add a calendar so that the nurse can see all the encouters, HUV1, HOPE, CTI, F2F, MSW visits,...
So when there is something regarding a patient, everybody can see it
- Review and Fix the error when signing a care plan
- Completed Admission in the HOPE admission after signing, the message should show the name of the user who signed
- She is also the one assigning the care team in the Care Team & Assignments tab
- Remove the verbal order Tab and add a button in the Order tab called Verbal order
Create a verbal order: physician communication, created by, created at, check box "read back and verified", effective date, and the order, then send it for sigature
ORG_WIDE_SCOPE_ROLES