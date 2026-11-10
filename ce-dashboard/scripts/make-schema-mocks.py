"""Generate wholly synthetic examples of the user-confirmed schemas. No raw source records."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'fixtures'/'schema-mocks'
ROOT.mkdir(parents=True,exist_ok=True)
def facility(bank, overdue=0):
    f={k:None for k in ['AmDirkard','DateEstehal','Estehal','MainIdNo','MainLName','MainLgId','MainName']}
    f.update({k:'0' for k in ['AmPeigiri','EmhalBase','EmhalType','EmhalStatus','EmhalDate','GrpType','AmEltezam','AmSukht','AmTahod']})
    f.update(AmBedehiKol='730000', AmBenefit='48000.00000', AmOriginal='1200000.00000',
             AmMoavagh=str(overdue),AmSarResid='0',AmMashkuk='0',Date='14020211',DateSarResid='14040211',
             LastVarizDate='14030310 09:00:00.000',Status='4',DasteBandi='1',Type='26',HadafAzDaryaft='3',PlaceCdMasraf='100',RequstType='3',RsrcTamin='1')
    if bank=='resalat': f.update(ArzCode='IRR',BankCode='99901',ShobeCode='SYNTHETIC-BRANCH',ShobeName='شعبهٔ ساختگی',BnkShb='بانک ساختگی - شعبهٔ فرضی',RequestNum='SYNTHETIC-FACILITY-1')
    else:
        f.update(ArzCD=None if bank=='mellat' else 'IRR',ArzRate=None,BnkCD=99901,BnkShb='********',GhrType=None,RequestNO=None if bank=='mellat' else 'SYNTHETIC-FACILITY-2',ShbCD=None if bank=='mellat' else 'SYNTHETIC-BRANCH')
        if bank=='mellat':
            for k in ['LastVarizDate','Status','Type','EmhalBase','EmhalType','EmhalStatus','EmhalDate','AmPeigiri']: f[k]=None
    return f
def base(bank):
    return {'input':{'method':'tavan_'+bank,'data':{'nationalCode':'SYNTHETIC-NATIONAL-CODE'},'uniqueKey':'SYNTHETIC-KEY-'+bank},
            'requestId':'SYNTHETIC-REQUEST-'+bank,'sourceIp':'192.0.2.10',
            'insertDate_full':'14030418103000000','insertDate_yearMonth':'140304','insertDate_year':'1403','insertDate_yearMonthDay':'14030418',
            'output':{'model_name':'synthetic_model','total_time':1.25,'nationalCode':'SYNTHETIC-NATIONAL-CODE','message':{'fa':'درخواست اعتبارسنجی با موفقیت انجام شد.','en':'Validation was successful.'},'date_granted':'14030418','version':'synthetic'}}
rotbe={'data':{k:[] for k in ['personRoles','summaryInformationRelatedToContractsSumWithRoleType','summaryInformationRelatedToContractsWithRoleType','directContracts','summaryInformationRelatedToContracts','contractNegativeStatus','inquiryStats','personNegativeStatus','inquiryHistories','summaryInformationRelatedToContractsSum']},'status':200,'messageList':[],'total':None}
rotbe['data'].update(personInformation={'name':'نام ساختگی','family':'نام خانوادگی ساختگی','fatherName':'نام ساختگی','nationalCode':'SYNTHETIC-NATIONAL-CODE','dateOfBirth':'****/**/**','address':'نشانی ساختگی','contacts':[{'title':'تلفن همراه','value':'[MASKED-CONTACT]'}]},reportUniqueId='SYNTHETIC-CREDIT-REPORT',inquiryCreatedDate='1403/04/18 10:30:00')
r=base('resalat');r['ai_input']={k:{'status':'ok','data':'mock'} for k in ['iran','EstelamAsliRows','chequeList','historical_loans','averageDeposit']}
r['ai_input'].update(current_loan={'date_granted':'14030418','national_code':'SYNTHETIC-NATIONAL-CODE'},requestId=r['requestId'],serviceName='tavan-resalat')
r['input']['data']['currentLoan']={'amountApproved':1800000,'countInstallment':3,'dateGranted':'1403/04/18'}
loan={'id_doc':'SYNTHETIC-LOAN','national_code':'SYNTHETIC-NATIONAL-CODE','customer_code':'SYNTHETIC-CUSTOMER','amount_approved':'1800000','count_installment':'3','date_granted':'14020311'}
for i in range(181):
    loan['pay_install_'+str(i)]='600000' if i<3 else 'null'
    loan['delay_dayes_'+str(i)]=str([0,45,7][i]) if i<3 else 'null'
account={'customer_code':'SYNTHETIC-CUSTOMER','deposit_number':'SYNTHETIC-ACCOUNT','dep_avg':'64000.25','first_name':'نام ساختگی','home_account_number':'SYNTHETIC-HOME-ACCOUNT','kanoon_code':'SYNTHETIC-CENTER','kanoon_name':'مرکز ساختگی','last_name':'نام خانوادگی ساختگی','max_bes':'98000','mobile':'[MASKED-CONTACT]','national_code':'SYNTHETIC-NATIONAL-CODE','opening_date':'14010115','postal_code':'[MASKED-POSTCODE]','rem_deposit':'27000'}
r['input']['data']['collectedData']={'rotbebandiStandard':rotbe,'samatFacilities':{'tashilat':{'DateEstlm':'14030418','LName':'نام خانوادگی ساختگی','ShenaseEstlm':'SYNTHETIC-INQUIRY','NationalCd':'SYNTHETIC-NATIONAL-CODE','CustomerType':'1','LegalId':None,'BadHesabiDate':None,'FName':'نام ساختگی','ShenaseRes':'SYNTHETIC-RESPONSE','TashilatItem':[facility('resalat',18000)]}},'samatCheque':{'chequeList':[]},'meratInformation':[],'historicalLoans':[loan],'depositAverage':[account,{**account,'deposit_number':'SYNTHETIC-ZERO-ACCOUNT','dep_avg':'0'}]}
r['output'].update(suggested_tavan_bazpardakht=32000000,deposit_ok=1,average_deposit_36_month=125000,average_deposit_6_month=155000,requested_loan={'base_loan':{'base_pd_default':.23},'score':{'score_value':620,'category':'Good','category_range':'601-650'}},model_default_threshold=.4)
p=base('postbank'); p['input'].pop('uniqueKey');p['output'].update(pd_default=.18,suggested_tavan_bazpardakht=620000000,average_deposit_24_month=84000,average_deposit_6_month=96000,deposit_ok=1,model_default_threshold=.4)
meta={'requestId':'SYNTHETIC-SERVICE-REQUEST','shamsiDate':'14030418103000000'}
inst={'loanNumber':'SYNTHETIC-LOAN','customerNumber':'SYNTHETIC-CUSTOMER','loanOwnershipStatus':'1','installmentNumber':'1','installmentAmount':'600000','profitAmount':'20000','penaltyAmount':'0','installmentStatus':'true','installmentDuce-dashboardte':'1402/03/11','installmentPaymentDate':'1402/03/11','numberOfDaysOfDelay':None,'amountPaid':'600000','amountUnpaid':'0','remainedDebt':'0'}
p['collectedData']={'rotbebandiStandardResult':rotbe,
 'samatFacilitiesResult':{'meta':meta,'data':{'ReturnValue':{'TashilatItem':[facility('postbank')],'TotalAmMoavagh':0,'TotalAmBedehi':730000,'TotalAmMashkuk':0,'TotalAmTashilat':1200000,'TotalAmSarResid':0,'NationalCd':'SYNTHETIC-NATIONAL-CODE','Name':'نام ساختگی','ShenaseEstlm':'SYNTHETIC-INQUIRY'}}},
 'samatChequeResult':{'meta':meta,'data':{'chequeList':[],'name':'نام ساختگی'}},
 'postBankDepositAverageResult':{'meta':meta,'data':{'averageList':[{'depositNumber':'SYNTHETIC-ACCOUNT','type':'JARI_ACCOUNT','average':{'1403/01':'36000.5','1403/02':72000,'1403/03':'108000'}}],'customerNumber':'SYNTHETIC-CUSTOMER'}},
 'postBankLoansDataResult':{'meta':meta,'data':{'resultData':[{'fileNumber':'SYNTHETIC-LOAN','title':'عنوان ساختگی','requestDate':'1402/02/11','grantDate':'1402/02/11','endDate':'1402/05/11','realEndDate':'1402/05/11','installmentCount':'3','requestedDuration':'3','approvedDuration':'3','loanTypeCode':'610','loanMajorType':'82','loanTypeName':'مرابحه','requestce-dashboardmount':'1800000','approvce-dashboardmount':'1800000','debtAmount':'0','totalDebtAmount':'0','currencyName':'ریال','swiftCode':'IRR','fileState':'تسویه شده','fileStatus':'6','installments':[inst,{**inst,'installmentNumber':'2','numberOfDaysOfDelay':'65'},{**inst,'installmentNumber':'3','numberOfDaysOfDelay':'0'}]}],'errorCode':'0'}}}
m=base('mellat');m['input']['data'].pop('nationalCode');m['output'].pop('nationalCode');m['output'].update(Credit_Basket=500000000,PD=.31,Tavan_Baz_Pardakht={'Good':{'min':15000000,'max':22000000}},score={'score_value':612,'category':'Good'})
m['input']['data'].update(samatFacilities={'TashilatItem':[facility('mellat')],'TotalAmSarResid':'0','TotalAmMashkuk':'0','TotalAmTashilat':'1200000','TotalAmBedehi':'730000','TotalAmMoavagh':'0','Name':None,'NationalCd':'','ShenaseEstlm':'SYNTHETIC-INQUIRY'},
 historicalLoans=[{'contractNumber':1,'requestDate':'1402/02/11','originalLoanAmount':1800000,'benefitLoanAmount':60000,'installmentCount':3,'approvedDuration':3,'grantDate':'1402/02/11','expectedEndDate':'1402/05/11','realEndDate':None,'loanTypeCode':58,'loanTypeName':'مرابحه','status':1,'installments':[{'installmentNumber':1,'amount':600000,'interest':20000,'penalty':1500,'scheduledDate':'1402/03/11','deliveryDate':None,'remainingAmount':None,'installmentPayments':[{'amount':621500,'interest':0,'penalty':0,'date':None,'delay':None}]}]}],
 rotbebandiStandard={'data':{k:None for k in rotbe['data']},'messageList':[],'total':None,'status':200},samatCheque={'chequeList':[],'name':''},depositAverage=[{'avR_AMOUNT':36000,'yeaR_MONTH':14030331},{'avR_AMOUNT':72000,'yeaR_MONTH':14030231}])
for name,data in [('resalat',r),('postbank',p),('mellat',m)]:
    (ROOT/(name+'.json')).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
